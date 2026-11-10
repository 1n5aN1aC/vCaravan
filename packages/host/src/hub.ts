import {
  NET,
  redactEvents,
  redactFor,
  type ClientMessage,
  type Difficulty,
  type EndReason,
  type TableMessage,
} from '@caravan/protocol';
import {
  DEFAULT_DECK_MODE,
  IllegalMoveError,
  applyMove,
  checkDeckSelection,
  createMatch,
  type DeckModeId,
  type GameEvent,
  type Move,
  type Seat,
} from '@caravan/rules';
import { chooseMove } from './bot.js';
import { pickBotDeck } from './deck-strategies.js';
import {
  InMemoryMatchStore,
  SeatTokens,
  generateCode,
  generateSeed,
  type MatchStore,
  type Room,
} from './store.js';

export interface Connection {
  send(message: TableMessage): void;
  close(): void;
}

/**
 * The AI's seat. It is a `Connection` purely so it occupies seat 1 the way a
 * peer link would — presence, room status and "that room is full" all keep working
 * with no special cases. It is never actually sent anything: the bot is driven
 * from `room.state` after each move, not from redacted messages, because it has
 * to hand real state to the engine to score a move.
 */
class BotConnection implements Connection {
  send(): void {}
  close(): void {}
}

/** Runs `fn` after `ms`, returning a cancel. Injected so tests need no clock. */
export type Scheduler = (fn: () => void, ms: number) => () => void;

const realScheduler: Scheduler = (fn, ms) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

/** How long the AI "thinks" before playing, so the table does not snap. */
export const BOT_DELAY_MS = 800;

export interface TableOptions {
  bot?: Difficulty;
  mode?: DeckModeId;
}

interface Session {
  connection: Connection;
  code: string;
  seat: Seat;
}

/**
 * All room and match orchestration, with no knowledge of the transport — which
 * is what lets it run in the host's browser tab behind PeerJS, and be driven by
 * a scripted move list in tests.
 */
export class Hub {
  private sessions = new Map<Connection, Session>();
  /** code -> connection per seat. */
  private seats = new Map<string, [Connection | null, Connection | null]>();
  /** code -> cancel for the pending AI move, so one is never queued twice. */
  private botTimers = new Map<string, () => void>();

  constructor(
    private readonly store: MatchStore = new InMemoryMatchStore(),
    private readonly tokens = new SeatTokens(),
    private readonly now: () => number = Date.now,
    private readonly schedule: Scheduler = realScheduler,
  ) {}

  handle(connection: Connection, message: ClientMessage): void {
    switch (message.t) {
      case 'ping':
        return connection.send({ t: 'pong' });
      case 'create':
        return this.create(connection, { bot: message.bot, mode: message.mode });
      case 'join':
        return this.join(connection, message.code);
      case 'resume':
        return this.resume(connection, message.token);
      case 'deck':
        return this.deck(connection, message.keep);
      case 'move':
        return this.move(connection, message.move);
      case 'rematch':
        return this.rematch(connection);
      case 'leave':
        return this.disconnect(connection);
    }
  }

  disconnect(connection: Connection): void {
    const session = this.sessions.get(connection);
    this.sessions.delete(connection);
    if (!session) return;

    const occupants = this.seats.get(session.code);
    if (!occupants || occupants[session.seat] !== connection) return;
    occupants[session.seat] = null;

    const room = this.store.get(session.code);
    if (!room) return;
    // The seat stays claimed — only a token holder may take it back, and only
    // inside the grace window.
    room.disconnectedAt[session.seat] = this.now();
    room.lastActivity = this.now();
    this.broadcastRoom(room);
  }

  /** Drives reconnect expiry and the idle sweep. Called on a timer. */
  tick(): void {
    const now = this.now();
    for (const room of this.store.all()) {
      if (now - room.lastActivity > NET.IDLE_SWEEP_MS) {
        this.endRoom(room, 'idle');
        continue;
      }
      if (room.ended) continue;
      const expired = room.disconnectedAt.some(
        (at, seat) => at !== null && room.claimed[seat] && now - at > NET.RECONNECT_GRACE_MS,
      );
      // Abandonment only matters once both seats were actually in the match.
      if (expired && room.claimed[0] && room.claimed[1]) {
        this.endRoom(room, 'abandoned');
      }
    }
  }

  /**
   * Opens a room under a code the caller already holds. A browser host has to
   * claim its code on the PeerJS broker *before* the room exists — the code is
   * the address a guest dials — so it cannot let `create` pick one.
   */
  host(connection: Connection, options: TableOptions & { code: string }): void {
    if (this.store.get(options.code)) return this.fail(connection, 'that code is already open');
    this.create(connection, options);
  }

  /**
   * Puts back a room saved before a refresh. Every human seat comes back
   * disconnected, inside a fresh grace window, and is reclaimed by `resume` with
   * its token like any other dropped connection — the host's own seat included.
   */
  restore(room: Room): void {
    this.store.create(room);
    this.seats.set(room.code, [null, null]);
    const now = this.now();
    ([0, 1] as Seat[]).forEach((seat) => {
      if (room.claimed[seat]) room.disconnectedAt[seat] = now;
    });
    room.lastActivity = now;
    if (room.bot) {
      this.seatBot(room);
      this.scheduleBot(room);
    }
  }

  /** Ends a room from outside — the host leaving takes the table with it. */
  end(code: string, reason: EndReason): void {
    const room = this.store.get(code);
    if (room) this.endRoom(room, reason);
  }

  // -- room lifecycle -------------------------------------------------------

  private create(connection: Connection, options: TableOptions & { code?: string }): void {
    const code = options.code ?? generateCode((c) => this.store.get(c) !== undefined);
    const room: Room = {
      code,
      seed: generateSeed(),
      bot: options.bot ?? null,
      mode: options.mode ?? DEFAULT_DECK_MODE,
      state: null,
      decks: [null, null],
      moves: [],
      claimed: [true, false],
      rematch: [false, false],
      disconnectedAt: [null, null],
      lastActivity: this.now(),
      ended: false,
    };
    this.store.create(room);
    this.seats.set(code, [connection, null]);
    this.seat(connection, room, 0);

    // Single player: the AI takes seat 1 immediately, so the only thing the
    // deal is still waiting on is the host's own deck. `hard` and `extreme` in
    // `build` mode draw a random named strategy (see `pickBotDeck`); every
    // other difficulty/mode still brings the whole pool, the same deck a
    // human who removed nothing would.
    if (room.bot) {
      room.claimed[1] = true;
      room.decks[1] = pickBotDeck(room.bot, room.mode, room.seed, 1);
      this.seatBot(room);
    }

    this.maybeStart(room);
  }

  private seatBot(room: Room): void {
    const botConnection = new BotConnection();
    room.disconnectedAt[1] = null;
    this.seats.get(room.code)![1] = botConnection;
    this.sessions.set(botConnection, { connection: botConnection, code: room.code, seat: 1 });
  }

  private join(connection: Connection, code: string): void {
    const room = this.store.get(code);
    if (!room) return this.fail(connection, 'no room with that code');
    if (room.ended) return this.fail(connection, 'that match has ended');
    if (room.claimed[1]) return this.fail(connection, 'that room is full');

    room.claimed[1] = true;
    const occupants = this.seats.get(code)!;
    occupants[1] = connection;
    this.seat(connection, room, 1);

    // Both seats claimed: the room moves to deck building. The deal waits for
    // both built decks — see `deck` below, and `maybeStart` for the moment the
    // second one lands.
    room.lastActivity = this.now();
    this.maybeStart(room);
  }

  /**
   * A seat's built deck. Accepted any time before the deal — the host can trim
   * theirs while still waiting for an opponent — and validated by the same
   * rules code the client's builder counts with.
   */
  private deck(connection: Connection, keep: string[]): void {
    const session = this.sessions.get(connection);
    if (!session) return this.fail(connection, 'you are not seated');
    const room = this.store.get(session.code);
    if (!room || room.ended) return this.fail(connection, 'that room is gone');
    if (room.state) return this.fail(connection, 'the match has already been dealt');
    if (room.decks[session.seat]) return this.fail(connection, 'your deck is already in');

    const reason = checkDeckSelection(session.seat, keep, room.mode);
    if (reason !== null) return this.fail(connection, reason);

    room.decks[session.seat] = [...keep];
    room.lastActivity = this.now();
    this.maybeStart(room);
  }

  /** Deals the moment both seats are claimed and both decks are in. */
  private maybeStart(room: Room): void {
    if (room.claimed[0] && room.claimed[1] && room.decks[0] && room.decks[1]) {
      const { state, events } = createMatch(room.seed, [room.decks[0], room.decks[1]]);
      room.state = state;
      this.broadcastRoom(room);
      this.broadcastState(room, events);
    } else {
      this.broadcastRoom(room);
    }
  }

  /**
   * An offer to play the same table again, which only takes once both seats have
   * made it — the AI is always willing, so a solo table restarts on the host's
   * click alone. The room is kept (code, seats and tokens all survive); only the
   * match is thrown away, so a rematch is a redeal rather than a new room.
   */
  private rematch(connection: Connection): void {
    const session = this.sessions.get(connection);
    if (!session) return this.fail(connection, 'you are not seated');
    const room = this.store.get(session.code);
    if (!room) return this.fail(connection, 'that room is gone');
    if (room.state?.phase !== 'over') return this.fail(connection, 'that match is still going');

    room.rematch[session.seat] = true;
    if (room.bot) room.rematch[1] = true;
    room.lastActivity = this.now();
    if (!room.rematch[0] || !room.rematch[1]) return this.broadcastRoom(room);

    // A fresh seed, so the rematch is a different deal and not the same one
    // replayed. Decks are rebuilt too: the builder is part of the match.
    room.seed = generateSeed();
    room.state = null;
    room.moves = [];
    room.decks = [null, room.bot ? pickBotDeck(room.bot, room.mode, room.seed, 1) : null];
    room.rematch = [false, false];
    room.ended = false;
    this.maybeStart(room);
  }

  private resume(connection: Connection, token: string): void {
    const claim = this.tokens.verify(token);
    if (!claim) return this.fail(connection, 'that seat token is not valid');
    const room = this.store.get(claim.code);
    if (!room) return this.fail(connection, 'that room is gone');
    if (!room.claimed[claim.seat]) return this.fail(connection, 'that seat was never taken');

    const occupants = this.seats.get(claim.code)!;
    // A second live tab for the same seat displaces the first rather than
    // silently forking the view.
    occupants[claim.seat]?.close();
    occupants[claim.seat] = connection;
    room.disconnectedAt[claim.seat] = null;
    room.lastActivity = this.now();

    this.sessions.set(connection, { connection, code: room.code, seat: claim.seat });
    connection.send({
      t: 'seated',
      code: room.code,
      seat: claim.seat,
      token: this.tokens.issue(room.code, claim.seat),
    });
    this.broadcastRoom(room);
    if (room.state) this.sendState(connection, room, claim.seat, []);
  }

  private seat(connection: Connection, room: Room, seat: Seat): void {
    this.sessions.set(connection, { connection, code: room.code, seat });
    room.disconnectedAt[seat] = null;
    connection.send({
      t: 'seated',
      code: room.code,
      seat,
      token: this.tokens.issue(room.code, seat),
    });
  }

  private endRoom(room: Room, reason: EndReason): void {
    room.ended = true;
    this.botTimers.get(room.code)?.();
    this.botTimers.delete(room.code);
    for (const connection of this.seats.get(room.code) ?? []) {
      connection?.send({ t: 'ended', reason });
    }
    this.seats.delete(room.code);
    this.store.delete(room.code);
    this.tokens.forget(room.code);
  }

  // -- moves ----------------------------------------------------------------

  private move(connection: Connection, move: Move): void {
    const session = this.sessions.get(connection);
    if (!session) return this.fail(connection, 'you are not seated');
    const room = this.store.get(session.code);
    if (!room?.state) return this.fail(connection, 'no match in progress');

    try {
      // The host re-validates independently; the client's own legality check
      // is advisory UI only.
      const { state, events } = applyMove(room.state, session.seat, move);
      room.state = state;
      room.moves.push({ seat: session.seat, move });
      room.lastActivity = this.now();
      this.broadcastState(room, events);
    } catch (error) {
      const message = error instanceof IllegalMoveError ? error.message : 'move failed';
      connection.send({ t: 'error', message, resync: true });
      // A rejected intent means the client's view may be stale — resync it.
      this.sendState(connection, room, session.seat, []);
    }
  }

  // -- outbound -------------------------------------------------------------

  private fail(connection: Connection, message: string): void {
    connection.send({ t: 'error', message, resync: false });
  }

  private broadcastRoom(room: Room): void {
    const occupants = this.seats.get(room.code) ?? [null, null];
    const graceStart = room.disconnectedAt.find((at) => at !== null) ?? null;
    const message: TableMessage = {
      t: 'room',
      code: room.code,
      mode: room.mode,
      // A room whose match is decided is `ended` but still very much alive — it
      // can be rematched. Rooms that are truly finished are deleted by
      // `endRoom`, which says so with an `ended` message of its own, so nothing
      // this broadcast reaches is ever past playing.
      status: room.state ? 'playing' : room.claimed[1] ? 'building' : 'waiting',
      present: [occupants[0] !== null, occupants[1] !== null],
      decksReady: [room.decks[0] !== null, room.decks[1] !== null],
      rematch: [...room.rematch],
      reconnectDeadline: graceStart === null ? null : graceStart + NET.RECONNECT_GRACE_MS,
    };
    for (const connection of occupants) connection?.send(message);
  }

  private broadcastState(room: Room, events: GameEvent[]): void {
    const occupants = this.seats.get(room.code) ?? [null, null];
    ([0, 1] as Seat[]).forEach((seat) => {
      const connection = occupants[seat];
      if (connection) this.sendState(connection, room, seat, events);
    });
    if (room.state?.phase === 'over') room.ended = true;
    this.scheduleBot(room);
  }

  /**
   * Queues the AI's reply whenever the position has come round to its seat. The
   * move goes back in through the ordinary `move` path, so it is re-validated by
   * the engine and recorded in `room.moves` exactly like a human's — a solo match
   * replays from seed + decks + moves the same as any other.
   */
  private scheduleBot(room: Room): void {
    this.botTimers.get(room.code)?.();
    this.botTimers.delete(room.code);
    if (!room.bot || room.ended || !room.state) return;
    if (room.state.turn !== 1 || room.state.phase === 'over') return;

    const connection = this.seats.get(room.code)?.[1];
    if (!connection) return;

    const cancel = this.schedule(() => {
      this.botTimers.delete(room.code);
      // The room may have ended, or the turn moved on, while this was pending.
      const current = this.store.get(room.code);
      if (!current?.state || current.ended) return;
      if (current.state.turn !== 1 || current.state.phase === 'over') return;
      // The whole table is handed over; `chooseMove` decides which difficulty
      // is allowed to act on which part of it, so the private half (the
      // opponent's built deck) cannot leak into one that plays without it.
      const move = chooseMove(current.state, 1, room.bot!, {
        mode: current.mode,
        deck: current.decks[0] ?? undefined,
      });
      if (move) this.move(connection, move);
    }, BOT_DELAY_MS);

    this.botTimers.set(room.code, cancel);
  }

  /** The only path by which match state reaches a seat. */
  private sendState(
    connection: Connection,
    room: Room,
    seat: Seat,
    events: GameEvent[],
  ): void {
    if (!room.state) return;
    connection.send({
      t: 'state',
      state: redactFor(seat, room.state),
      events: redactEvents(seat, events),
    });
  }
}
