import { Peer, type DataConnection, type PeerError as PeerJsError } from 'peerjs';

/**
 * The one seam between the game and PeerJS. Everything above it speaks in
 * channels that carry plain objects, so tests can swap in an in-memory network
 * and the host and client never learn what WebRTC is.
 */

/** One open, two-way link to another tab. */
export interface Channel {
  send(message: unknown): void;
  close(): void;
  onmessage: ((message: unknown) => void) | null;
  /** Fires once, however the channel ended — either side closing, or failing. */
  onclose: (() => void) | null;
}

/** A registration on the broker, under which guests can reach this tab. */
export interface Listener {
  /** Whether the broker can currently route new guests here. Existing
      channels are peer-to-peer and outlive a broker outage. */
  onstatus: ((status: 'open' | 'closed') => void) | null;
  close(): void;
}

export interface PeerNetwork {
  /** Registers under `id` and hands over each guest that connects. */
  listen(id: string, onChannel: (channel: Channel) => void): Promise<Listener>;
  /** Opens a channel to whoever registered `id`. */
  connect(id: string): Promise<Channel>;
}

export type PeerErrorKind =
  /** Somebody else is registered under that id — or this tab still is, from
      before a refresh, and the broker has not noticed yet. */
  | 'taken'
  /** Nobody is registered under that id. */
  | 'unreachable'
  /** The broker, or the route to the other tab, could not be reached. */
  | 'network';

export class PeerError extends Error {
  constructor(
    readonly kind: PeerErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** A broker and route that never answered is a network failure, not a refusal. */
const CONNECT_TIMEOUT_MS = 15_000;
const BROKER_RETRY_MS = 3_000;

/**
 * PeerJS over its free public broker, with STUN only. That covers most home
 * networks; a pair that are both behind strict NATs would need a TURN relay,
 * which can be added to `config.iceServers` here without touching anything else.
 */
export function peerJsNetwork(options: ConstructorParameters<typeof Peer>[1] = {}): PeerNetwork {
  return {
    listen(id, onChannel) {
      return new Promise((resolve, reject) => {
        const peer = new Peer(id, options);
        let opened = false;
        const listener: Listener = {
          onstatus: null,
          close: () => peer.destroy(),
        };

        peer.on('open', () => {
          listener.onstatus?.('open');
          if (opened) return;
          opened = true;
          resolve(listener);
        });
        peer.on('connection', (connection) => {
          connection.on('open', () => onChannel(wrap(connection)));
        });
        // Losing the broker only stops new guests arriving. Keep asking for the
        // same id back until it answers or the table is closed.
        peer.on('disconnected', () => {
          if (!opened || peer.destroyed) return;
          listener.onstatus?.('closed');
          window.setTimeout(() => {
            if (!peer.destroyed && peer.disconnected) peer.reconnect();
          }, BROKER_RETRY_MS);
        });
        peer.on('error', (error: PeerJsError<string>) => {
          if (opened) return;
          peer.destroy();
          reject(toPeerError(error));
        });
      });
    },

    connect(id) {
      return new Promise((resolve, reject) => {
        // A guest needs a registration of its own to dial from. Its id is never
        // shown or reused, so the broker picks it.
        const peer = new Peer(options);
        let settled = false;
        const fail = (error: PeerError) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          peer.destroy();
          reject(error);
        };
        const timer = window.setTimeout(
          () => fail(new PeerError('network', 'the table did not answer')),
          CONNECT_TIMEOUT_MS,
        );

        peer.on('error', (error: PeerJsError<string>) => fail(toPeerError(error)));
        peer.on('open', () => {
          const connection = peer.connect(id, { reliable: true, serialization: 'json' });
          connection.on('open', () => {
            if (settled) return connection.close();
            settled = true;
            window.clearTimeout(timer);
            // The guest has no use for the broker once the link is up, and
            // keeping the registration would only hold a socket open.
            peer.disconnect();
            const channel = wrap(connection);
            const close = channel.close;
            channel.close = () => {
              close();
              peer.destroy();
            };
            resolve(channel);
          });
          connection.on('error', () => fail(new PeerError('network', 'could not reach the table')));
        });
      });
    },
  };
}

function wrap(connection: DataConnection): Channel {
  let closed = false;
  const channel: Channel = {
    send: (message) => {
      if (!closed && connection.open) void connection.send(message);
    },
    close: () => {
      connection.close();
      finish();
    },
    onmessage: null,
    onclose: null,
  };
  function finish() {
    if (closed) return;
    closed = true;
    channel.onclose?.();
  }
  connection.on('data', (data) => {
    if (!closed) channel.onmessage?.(data);
  });
  connection.on('close', finish);
  connection.on('error', finish);
  return channel;
}

function toPeerError(error: PeerJsError<string>): PeerError {
  switch (error.type) {
    case 'unavailable-id':
      return new PeerError('taken', 'that table code is already in use');
    case 'peer-unavailable':
      return new PeerError('unreachable', 'no table with that code');
    default:
      return new PeerError('network', 'could not reach the PeerJS broker');
  }
}
