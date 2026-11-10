import {
  NET,
  type ClientMessage,
  type Difficulty,
  type RedactedState,
  type TableMessage,
} from '@caravan/protocol';
import { DEFAULT_DECK_MODE, type DeckModeId, type GameEvent, type Move } from '@caravan/rules';
import { PeerError, peerJsNetwork, type Channel, type PeerNetwork } from './peer.js';
import { HostTable, peerIdFor, type Link, type TableStatus } from './table.js';

/**
 * `idle` before there is any table; `local` for a solo table, which has no
 * network to be connected to. Otherwise, how this tab's link to the table is
 * doing — for the host, whether guests can reach it.
 */
export type Connectivity = 'idle' | TableStatus;

export interface ClientState {
  connectivity: Connectivity;
  code: string | null;
  seat: 0 | 1 | null;
  /** Whether this tab is running the table, rather than playing at someone else's. */
  hosting: boolean;
  status: 'idle' | 'waiting' | 'building' | 'playing' | 'ended';
  /**
   * Which cards this table plays with. Comes from the host rather than from
   * whatever was picked on the create screen, because a seat that joined by
   * code — or reconnected into one — never saw that screen.
   */
  mode: DeckModeId;
  present: [boolean, boolean];
  /** Per seat: has that seat's built deck been accepted by the host. */
  decksReady: [boolean, boolean];
  /** Per seat: has that seat offered a rematch of the match on screen. */
  rematch: [boolean, boolean];
  reconnectDeadline: number | null;
  match: RedactedState | null;
  /**
   * What happened to produce `match`, always replaced alongside it. The board
   * renders from the snapshot alone; this is read for one thing only, which is
   * knowing which card caused a removal so it can be seen causing it.
   */
  events: GameEvent[];
  error: string | null;
  endedReason: string | null;
}

/**
 * The seat token. In session storage rather than local storage: it survives a
 * refresh, which is the point, but each tab keeps its own — so two tabs of one
 * browser can sit at the same table without fighting over a seat.
 */
const TOKEN_KEY = 'caravan.seatToken';
const REDIAL_MS = 3_000;

const initial: ClientState = {
  connectivity: 'idle',
  code: null,
  seat: null,
  hosting: false,
  status: 'idle',
  mode: DEFAULT_DECK_MODE,
  present: [false, false],
  decksReady: [false, false],
  rematch: [false, false],
  reconnectDeadline: null,
  match: null,
  events: [],
  error: null,
  endedReason: null,
};

export interface ClientOptions {
  /** Defaults to PeerJS over its public broker, created on first use. */
  network?: PeerNetwork;
  /** Defaults to `sessionStorage`. */
  storage?: Storage | null;
}

/**
 * One tab's seat at a table. Hosting, the table runs in this tab (see
 * `HostTable`) and the seat talks to it over a local link; joining, the seat
 * talks to the host's tab over a PeerJS channel, with a heartbeat and redial,
 * and a token in session storage so a refresh is a non-event.
 */
export class CaravanClient {
  state: ClientState = initial;
  private link: Link | null = null;
  private table: HostTable | null = null;
  private heartbeat: number | null = null;
  private redial: number | null = null;
  /** When the host was last heard from, over a PeerJS link. */
  private heard = 0;
  /** When a guest that lost its host gives up on it coming back. */
  private giveUpAt: number | null = null;
  /**
   * A `join` or `resume` is in flight. An error before `seated` means the seat
   * was refused — and, for a resume, that the remembered token is dead.
   */
  private claiming: 'join' | 'resume' | null = null;
  /**
   * A table is being opened or a code dialled, and nothing is linked yet. The
   * start page has no seat to hide behind during that wait, so this is what
   * stops a second click opening a second table — or a second dial.
   */
  private opening = false;
  /** Bumped by `dispose`, `cancel` and `leave`, so async work — and messages
      from a table — started before any of them knows to stand down. */
  private epoch = 0;
  private listeners = new Set<() => void>();
  private readonly storage: Storage | null;
  private peers: PeerNetwork | null;

  constructor(options: ClientOptions = {}) {
    this.peers = options.network ?? null;
    this.storage = options.storage !== undefined ? options.storage : sessionStorageOrNull();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ClientState => this.state;

  /** Picks up whatever this tab was doing before a refresh, if anything. */
  start(): void {
    if (this.link) return;
    const snapshot = HostTable.saved(this.storage);
    const token = this.read(TOKEN_KEY);
    if (snapshot && token) {
      const { table, link } = HostTable.restore(snapshot, this.tableOptions());
      this.table = table;
      this.link = link;
      this.patch({ hosting: true });
      this.resume(token);
      return;
    }
    if (token) void this.dial(codeOf(token));
  }

  /** With a difficulty, seat 1 is filled by the AI; without, it waits for a human. */
  async createRoom(bot?: Difficulty, mode?: DeckModeId): Promise<void> {
    if (this.link || this.opening) return;
    this.opening = true;
    this.patch({ connectivity: bot ? 'local' : 'connecting', hosting: true, error: null });
    const epoch = this.epoch;
    try {
      const { table, link } = await HostTable.create({ bot, mode }, this.tableOptions(bot));
      // Cancelled, or unmounted, while the broker was still answering. Nobody
      // has seen the code yet, so the table is ended outright rather than put
      // away for a reload to resurrect.
      if (epoch !== this.epoch) return table.close('abandoned');
      this.opening = false;
      this.table = table;
      this.link = link;
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.opening = false;
      this.patch({
        connectivity: 'idle',
        hosting: false,
        error:
          error instanceof PeerError
            ? `Could not open a table online: ${error.message}. Try again in a moment.`
            : 'Could not open a table.',
      });
    }
  }

  joinRoom(code: string): void {
    if (this.link || this.opening) return;
    this.opening = true;
    void this.dial(code.trim().toUpperCase());
  }

  /**
   * Gives up on a table still being opened or dialled — including a refreshed
   * guest's redial, which is the one wait the player did not start themselves.
   */
  cancel(): void {
    if (this.state.seat !== null) return;
    this.epoch++;
    this.opening = false;
    this.remove(TOKEN_KEY);
    this.drop();
    this.patch(initial);
  }

  /** The card ids this seat's built deck keeps. Sent once, before the deal. */
  submitDeck(keep: string[]): void {
    this.send({ t: 'deck', keep });
  }

  play(move: Move): void {
    this.send({ t: 'move', move });
  }

  /** Offer to play the table again. Dealt once both seats have offered. */
  rematch(): void {
    this.send({ t: 'rematch' });
  }

  leave(): void {
    // The host's own table delivers on a microtask, so its goodbye — and
    // anything else still queued — lands after this has already gone back to
    // the start page. A new epoch keeps all of it from arriving there.
    this.epoch++;
    this.opening = false;
    this.remove(TOKEN_KEY);
    if (this.table) {
      // The table lives in this tab, so leaving takes it down for the guest too.
      this.table.close('opponent-left');
      this.table = null;
    } else {
      this.send({ t: 'leave' });
    }
    this.drop();
    this.patch(initial);
  }

  dispose(): void {
    this.epoch++;
    // Unmounting is not leaving: a hosted table is put away as saved, and
    // `start` brings it back.
    this.table?.suspend();
    this.table = null;
    this.drop();
  }

  // -- links ------------------------------------------------------------------

  private network(): PeerNetwork {
    this.peers ??= peerJsNetwork();
    return this.peers;
  }

  private tableOptions(bot?: Difficulty) {
    // A table abandoned by `cancel` or `dispose` still finishes what it was
    // doing — seating its host, reporting its registration — and none of that
    // may reach a client that has moved on.
    const epoch = this.epoch;
    return {
      network: bot ? null : this.network(),
      storage: this.storage,
      onStatus: (status: TableStatus) => {
        if (epoch === this.epoch) this.patch({ connectivity: status });
      },
      onMessage: (message: TableMessage) => {
        if (epoch === this.epoch) this.receive(message);
      },
    };
  }

  /** Connects to a host's tab: a `join` for a new seat, a `resume` for ours. */
  private async dial(code: string): Promise<void> {
    this.redial = null;
    this.patch({ connectivity: 'connecting', hosting: false });
    const epoch = this.epoch;
    let channel: Channel;
    try {
      channel = await this.network().connect(peerIdFor(code));
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.opening = false;
      if (this.read(TOKEN_KEY)) return this.lost();
      this.patch({
        connectivity: 'idle',
        error:
          error instanceof PeerError && error.kind === 'unreachable'
            ? 'No table with that code is open right now.'
            : 'Could not reach that table. Check the code and try again.',
      });
      return;
    }
    if (epoch !== this.epoch) return channel.close();
    this.opening = false;

    this.link = { send: (message) => channel.send(message), close: () => channel.close() };
    this.heard = Date.now();
    channel.onmessage = (message) => {
      this.heard = Date.now();
      this.receive(message as TableMessage);
    };
    channel.onclose = () => {
      if (this.link === null) return;
      this.drop();
      this.lost();
    };
    this.heartbeat = window.setInterval(() => {
      // WebRTC can be slow to notice a host tab that is simply gone; silence
      // past the timeout is taken as the answer.
      if (Date.now() - this.heard > NET.LINK_TIMEOUT_MS) return channel.close();
      this.send({ t: 'ping' });
    }, NET.PING_MS);
    this.patch({ connectivity: 'open' });

    const token = this.read(TOKEN_KEY);
    if (token && codeOf(token) === code) return this.resume(token);
    this.claiming = 'join';
    this.send({ t: 'join', code });
  }

  /**
   * The link to the host dropped. A seated guest keeps redialling — the host
   * may only be refreshing — for as long as the host would have waited for it.
   */
  private lost(): void {
    if (!this.read(TOKEN_KEY) || this.state.status === 'ended') {
      if (this.state.status !== 'ended') {
        this.patch({ ...initial, error: 'Lost the connection to the table.' });
      } else {
        this.patch({ connectivity: 'closed' });
      }
      return;
    }
    this.giveUpAt ??= Date.now() + NET.RECONNECT_GRACE_MS;
    if (Date.now() > this.giveUpAt) {
      this.giveUpAt = null;
      this.remove(TOKEN_KEY);
      this.patch({ connectivity: 'closed', status: 'ended', endedReason: 'abandoned' });
      return;
    }
    this.patch({ connectivity: 'closed' });
    const code = codeOf(this.read(TOKEN_KEY)!);
    this.redial = window.setTimeout(() => void this.dial(code), REDIAL_MS);
  }

  /** Lets go of the current link without saying anything over it. */
  private drop(): void {
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    if (this.redial !== null) window.clearTimeout(this.redial);
    this.heartbeat = null;
    this.redial = null;
    const link = this.link;
    this.link = null;
    // The host's own link has nothing to close; its table was dealt with.
    if (!this.state.hosting) link?.close();
  }

  private resume(token: string): void {
    this.claiming = 'resume';
    this.send({ t: 'resume', token });
  }

  private send(message: ClientMessage): void {
    this.link?.send(message);
  }

  private receive(message: TableMessage): void {
    switch (message.t) {
      case 'seated':
        this.claiming = null;
        this.giveUpAt = null;
        this.write(TOKEN_KEY, message.token);
        return this.patch({ code: message.code, seat: message.seat, error: null });
      case 'room':
        return this.patch({
          code: message.code,
          status: message.status,
          mode: message.mode,
          present: message.present,
          decksReady: message.decksReady,
          rematch: message.rematch,
          reconnectDeadline: message.reconnectDeadline,
          // Back to building with a match still on screen means a rematch was
          // agreed: the finished board is cleared out for the new deck build,
          // rather than the old result hanging over the fresh table.
          ...(message.status === 'building' && this.state.match
            ? { match: null, events: [], error: null }
            : {}),
        });
      case 'state':
        // The board renders from the snapshot alone, and *which* cards left is
        // still found by diffing consecutive snapshots (see useDepartures). The
        // events ride along only to say what removed them — a Jack destroys
        // itself with its target, so it is in no snapshot to be drawn from.
        // Patched together with the state they explain, never separately.
        return this.patch({
          match: message.state as RedactedState,
          events: message.events as GameEvent[],
        });
      case 'error':
        if (this.claiming) {
          // Refused a seat: a full table, or — resuming — a seat that is gone
          // because the table ended while this tab was away. Either way there
          // is nothing to stay connected for, and a dead token is forgotten
          // rather than resumed into the same refusal forever.
          const resuming = this.claiming === 'resume';
          this.claiming = null;
          this.remove(TOKEN_KEY);
          this.table?.close('abandoned');
          this.table = null;
          this.drop();
          return this.patch({
            ...initial,
            error: resuming ? 'That table has closed.' : capitalise(message.message),
          });
        }
        return this.patch({ error: message.message });
      case 'ended':
        this.remove(TOKEN_KEY);
        // A hosted table has already torn itself down by the time this lands.
        this.table = null;
        this.patch({ status: 'ended', endedReason: message.reason });
        // Keep the board up, but stop talking: there is nothing left to say.
        if (!this.state.hosting) {
          this.drop();
          this.patch({ connectivity: 'closed' });
        }
        return;
      case 'pong':
        return;
    }
  }

  private patch(next: Partial<ClientState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  private read(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private write(key: string, value: string): void {
    try {
      this.storage?.setItem(key, value);
    } catch {
      // Without storage a refresh loses the seat, and that is all.
    }
  }

  private remove(key: string): void {
    try {
      this.storage?.removeItem(key);
    } catch {
      // As above.
    }
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1) + '.';
}

/** Tokens read `CODE.seat.secret`; the code is also where the table lives. */
function codeOf(token: string): string {
  return token.split('.')[0]!;
}

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
