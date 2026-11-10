import {
  ClientMessage,
  NET,
  type Difficulty,
  type EndReason,
  type TableMessage,
} from '@caravan/protocol';
import {
  Hub,
  InMemoryMatchStore,
  SeatTokens,
  generateCode,
  type Connection,
  type Room,
} from '@caravan/host';
import type { DeckModeId } from '@caravan/rules';
import { PeerError, type Channel, type Listener, type PeerNetwork } from './peer.js';

/** The client's end of a link to whichever hub runs the table. */
export interface Link {
  send(message: ClientMessage): void;
  close(): void;
}

export type TableStatus = 'local' | 'connecting' | 'open' | 'closed';

/** Everything a refreshed host tab needs to carry on where it was. */
interface Snapshot {
  v: 1;
  /** Whether guests reach this table over PeerJS, or it is a solo table. */
  online: boolean;
  room: Room;
  tokens: Array<[string, string]>;
}

const SNAPSHOT_KEY = 'caravan.hostedTable';
/** How many fresh codes to try when the broker says one is taken. */
const CODE_ATTEMPTS = 5;
const RELISTEN_MS = 3_000;
/** Long enough for the last `ended` message to cross before the link drops. */
const FLUSH_MS = 1_000;
const SWEEP_MS = 5_000;
/** The same patience a guest has when dialling a table (see `peer.ts`). */
export const LISTEN_TIMEOUT_MS = 15_000;

/** The broker id a table registers under. Prefixed so it cannot collide with
    another app sharing the public broker. */
export function peerIdFor(code: string): string {
  return `caravan-table-${code.toLowerCase()}`;
}

/**
 * Only these may come from a guest. `create` would open a second room in the
 * host's tab; nothing else a guest could send is any different from what the
 * table accepts from the host's own tab.
 */
const GUEST_MESSAGES = new Set<ClientMessage['t']>([
  'join',
  'resume',
  'deck',
  'move',
  'rematch',
  'leave',
  'ping',
]);

/**
 * Registers on the broker, but gives up if it never answers — otherwise a
 * broker that accepted the socket and then went quiet would leave the host
 * looking at "Opening your table…" forever. A registration that does turn up
 * after the deadline is let go at once, so the code is not left held by a
 * table nobody is running.
 */
function listenWithin(
  network: PeerNetwork,
  id: string,
  onChannel: (channel: Channel) => void,
): Promise<Listener> {
  return new Promise((resolve, reject) => {
    let late = false;
    const timer = window.setTimeout(() => {
      late = true;
      reject(new PeerError('network', 'the PeerJS broker did not answer'));
    }, LISTEN_TIMEOUT_MS);
    network.listen(id, onChannel).then(
      (listener) => {
        if (late) return listener.close();
        window.clearTimeout(timer);
        resolve(listener);
      },
      (error: unknown) => {
        if (late) return;
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

interface Options {
  network: PeerNetwork | null;
  storage: Storage | null;
  onStatus: (status: TableStatus) => void;
  onMessage: (message: TableMessage) => void;
}

/**
 * The table, run in the host's own tab: the hub that used to live on the
 * server, plus the PeerJS registration guests reach it through. The host's own
 * seat talks to it over a local link with no network in between, so a solo
 * table needs no network at all.
 *
 * The room is saved to session storage after everything that touches it, so a
 * refresh puts it back — seats reclaimed by token, as with any reconnect.
 */
export class HostTable {
  private readonly store = new InMemoryMatchStore();
  private readonly tokens: SeatTokens;
  private readonly hub: Hub;
  /** When each guest last said anything, so a silent one can be let go. */
  private readonly guests = new Map<Connection, { channel: Channel; heard: number }>();
  private listener: Listener | null = null;
  private sweep: number;
  private closed = false;

  private constructor(
    readonly code: string,
    private readonly online: boolean,
    tokens: SeatTokens,
    private readonly options: Options,
  ) {
    this.tokens = tokens;
    this.hub = new Hub(this.store, this.tokens);
    this.sweep = window.setInterval(() => this.tick(), SWEEP_MS);
    options.onStatus(online ? 'connecting' : 'local');
  }

  /**
   * Opens a new table. An online one claims its code on the broker first —
   * the code *is* the address a guest dials — and only then opens the room.
   */
  static async create(
    table: { bot?: Difficulty; mode?: DeckModeId },
    options: Options,
  ): Promise<{ table: HostTable; link: Link }> {
    const { network } = options;
    let code = generateCode(() => false);
    let listener: Listener | null = null;
    if (network && !table.bot) {
      for (let attempt = 1; ; attempt++) {
        try {
          listener = await listenWithin(network, peerIdFor(code), (c) => host.accept(c));
          break;
        } catch (error) {
          if (!(error instanceof PeerError && error.kind === 'taken') || attempt >= CODE_ATTEMPTS) {
            throw error;
          }
          code = generateCode(() => false);
        }
      }
    }

    // Declared after the listen loop but used inside its callback: no guest
    // can arrive before the registration it dials has resolved.
    const host: HostTable = new HostTable(code, listener !== null, new SeatTokens(), options);
    if (listener) host.attach(listener);
    const { link, connection } = host.local();
    host.touch(() => host.hub.host(connection, { code, bot: table.bot, mode: table.mode }));
    return { table: host, link };
  }

  /** The table this tab was hosting before a refresh, if there was one. */
  static saved(storage: Storage | null): Snapshot | null {
    try {
      const raw = storage?.getItem(SNAPSHOT_KEY);
      if (!raw) return null;
      const snapshot = JSON.parse(raw) as Snapshot;
      return snapshot.v === 1 ? snapshot : null;
    } catch {
      return null;
    }
  }

  /**
   * Rebuilds a saved table. The caller resumes its own seat over the returned
   * link with its token, exactly as a guest resumes over PeerJS.
   */
  static restore(snapshot: Snapshot, options: Options): { table: HostTable; link: Link } {
    const host = new HostTable(
      snapshot.room.code,
      snapshot.online && options.network !== null,
      new SeatTokens(snapshot.tokens),
      options,
    );
    host.touch(() => host.hub.restore(snapshot.room));
    const { link } = host.local();
    if (host.online) void host.relisten();
    return { table: host, link };
  }

  /** Ends the table for both seats — the host leaving takes it with them. */
  close(reason: EndReason): void {
    if (this.closed) return;
    this.touch(() => this.hub.end(this.code, reason));
  }

  /**
   * Stops this tab running the table without ending it, so a remount — or a
   * reload — can pick it back up from what was saved.
   */
  suspend(): void {
    this.stop();
    this.listener?.close();
    for (const { channel } of this.guests.values()) channel.close();
  }

  // -- links ------------------------------------------------------------------

  private local(): { link: Link; connection: Connection } {
    const { onMessage } = this.options;
    const connection: Connection = {
      // Cloned, so the client can never hold a reference into the hub's own
      // state; delivered on a microtask, so the client sees the same ordering
      // it would over a real link rather than re-entering itself mid-send.
      send: (message) => {
        const copy = structuredClone(message);
        queueMicrotask(() => onMessage(copy));
      },
      close: () => {},
    };
    const link: Link = {
      send: (message) => this.touch(() => this.hub.handle(connection, message)),
      close: () => this.touch(() => this.hub.disconnect(connection)),
    };
    return { link, connection };
  }

  private accept(channel: Channel): void {
    if (this.closed) return channel.close();
    const connection: Connection = {
      send: (message) => channel.send(message),
      close: () => channel.close(),
    };
    const guest = { channel, heard: Date.now() };
    this.guests.set(connection, guest);

    channel.onmessage = (raw) => {
      guest.heard = Date.now();
      const parsed = ClientMessage.safeParse(raw);
      // Anything failing the schema never reaches the hub, let alone the engine.
      if (!parsed.success || !GUEST_MESSAGES.has(parsed.data.t)) {
        return connection.send({ t: 'error', message: 'invalid message', resync: false });
      }
      this.touch(() => this.hub.handle(connection, parsed.data));
    };
    channel.onclose = () => {
      this.guests.delete(connection);
      this.touch(() => this.hub.disconnect(connection));
    };
  }

  private attach(listener: Listener): void {
    this.listener = listener;
    listener.onstatus = (status) => {
      if (!this.closed) this.options.onStatus(status);
    };
    this.options.onStatus('open');
  }

  /**
   * Claims the table's code again after a refresh. The broker can go on
   * thinking the old tab holds it for a while, so `taken` is retried rather
   * than believed; the host can play on locally in the meantime.
   */
  private async relisten(): Promise<void> {
    const network = this.options.network!;
    while (!this.closed) {
      try {
        const listener = await listenWithin(network, peerIdFor(this.code), (c) => this.accept(c));
        if (this.closed) return listener.close();
        return this.attach(listener);
      } catch {
        this.options.onStatus('connecting');
        await new Promise((done) => window.setTimeout(done, RELISTEN_MS));
      }
    }
  }

  // -- housekeeping -----------------------------------------------------------

  private tick(): void {
    // WebRTC can take a long time to report a tab that simply vanished, so a
    // guest that has gone quiet is let go here rather than waited on.
    const now = Date.now();
    for (const guest of [...this.guests.values()]) {
      if (now - guest.heard > NET.LINK_TIMEOUT_MS) guest.channel.close();
    }
    this.touch(() => this.hub.tick());
  }

  /** Runs something against the hub, then saves — or tears down if it ended. */
  private touch(fn: () => void): void {
    if (this.closed) return;
    fn();
    const room = this.store.get(this.code);
    if (!room) return this.teardown();
    const snapshot: Snapshot = {
      v: 1,
      online: this.online,
      room,
      tokens: this.tokens.entries(),
    };
    try {
      this.options.storage?.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch {
      // A full or disabled store costs only refresh survival.
    }
  }

  private teardown(): void {
    this.stop();
    try {
      this.options.storage?.removeItem(SNAPSHOT_KEY);
    } catch {
      // Nothing to do about a disabled store.
    }
    const listener = this.listener;
    window.setTimeout(() => {
      listener?.close();
      for (const { channel } of this.guests.values()) channel.close();
    }, FLUSH_MS);
  }

  private stop(): void {
    this.closed = true;
    window.clearInterval(this.sweep);
  }
}
