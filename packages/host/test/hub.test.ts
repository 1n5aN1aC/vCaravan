import { ClientMessage, NET, type RedactedState, type TableMessage } from '@caravan/protocol';
import { buildDeck, buildPool, listLegalMoves } from '@caravan/rules';
import { beforeEach, describe, expect, it } from 'vitest';
import { Hub, type Connection } from '../src/hub.js';
import { InMemoryMatchStore, SeatTokens } from '../src/store.js';

/** A fake socket that just records what the table sent it. */
class TestConnection implements Connection {
  received: TableMessage[] = [];
  closed = false;
  send(message: TableMessage): void {
    this.received.push(message);
  }
  close(): void {
    this.closed = true;
  }
  last<T extends TableMessage['t']>(t: T): Extract<TableMessage, { t: T }> | undefined {
    return [...this.received].reverse().find((m) => m.t === t) as never;
  }
}

let now = 1_000_000;
let hub: Hub;
let store: InMemoryMatchStore;
let tokens: SeatTokens;
/** The AI's pending move, if one is queued. Nothing else uses the scheduler. */
let pending: Array<() => void>;

beforeEach(() => {
  now = 1_000_000;
  pending = [];
  store = new InMemoryMatchStore();
  tokens = new SeatTokens();
  hub = new Hub(store, tokens, () => now, schedule);
});

function schedule(fn: () => void): () => void {
  pending.push(fn);
  return () => {
    pending = pending.filter((f) => f !== fn);
  };
}

/** What a host tab does on refresh: a new hub, given back the saved room. */
function reload(code: string): void {
  const saved = JSON.parse(JSON.stringify(store.get(code)!));
  const secrets = tokens.entries();
  pending = [];
  store = new InMemoryMatchStore();
  tokens = new SeatTokens(secrets);
  hub = new Hub(store, tokens, () => now, schedule);
  hub.restore(saved);
}

/** Runs whatever the bot had queued, which typically queues the next one. */
function flushBot(): boolean {
  const due = pending;
  pending = [];
  for (const fn of due) fn();
  return due.length > 0;
}

function open(): TestConnection {
  return new TestConnection();
}

/** Creates a room and joins a second player, before either deck is in. */
function seatedPair(): { host: TestConnection; guest: TestConnection; code: string } {
  const host = open();
  hub.handle(host, { t: 'create' });
  const code = host.last('seated')!.code;
  const guest = open();
  hub.handle(guest, { t: 'join', code });
  return { host, guest, code };
}

/** Full 54s for both seats — the deck-building tests want the trimmed case,
    everything else wants a dealt match without caring how the deck got built. */
function submitFullDecks(host: TestConnection, guest: TestConnection): void {
  hub.handle(host, { t: 'deck', keep: buildDeck(0).map((c) => c.id) });
  hub.handle(guest, { t: 'deck', keep: buildDeck(1).map((c) => c.id) });
}

/** A room with both seats claimed and both decks in, ready to play. */
function pair(): { host: TestConnection; guest: TestConnection; code: string } {
  const seated = seatedPair();
  submitFullDecks(seated.host, seated.guest);
  return seated;
}

describe('rooms', () => {
  it('issues a six-letter code and seats the host', () => {
    const host = open();
    hub.handle(host, { t: 'create' });
    const seated = host.last('seated')!;
    expect(seated.code).toMatch(/^[A-Z]{6}$/);
    expect(seated.seat).toBe(0);
    expect(host.last('room')!.status).toBe('waiting');
  });

  it('moves to deck building, not straight to play, once the second player joins', () => {
    const { host, guest } = seatedPair();
    expect(guest.last('seated')!.seat).toBe(1);
    expect(host.last('room')!.status).toBe('building');
    expect(host.last('state')).toBeUndefined();
    expect(guest.last('state')).toBeUndefined();
  });

  it('starts the match once both decks are in', () => {
    const { host, guest } = pair();
    expect(host.last('room')!.status).toBe('playing');
    expect(host.last('room')!.decksReady).toEqual([true, true]);
    expect(host.last('state')).toBeDefined();
    expect(guest.last('state')).toBeDefined();
  });

  it('rejects a third joiner', () => {
    const { code } = pair();
    const third = open();
    hub.handle(third, { t: 'join', code });
    expect(third.last('error')!.message).toMatch(/full/);
    expect(third.last('seated')).toBeUndefined();
  });

  it('rejects an unknown room code', () => {
    const stray = open();
    hub.handle(stray, { t: 'join', code: 'ZZZZZZ' });
    expect(stray.last('error')!.message).toMatch(/no room/);
  });
});

describe('deck building', () => {
  it('lets the host trim a deck before an opponent has even joined', () => {
    const host = open();
    hub.handle(host, { t: 'create' });
    const kept = buildDeck(0).slice(0, 40).map((c) => c.id);
    hub.handle(host, { t: 'deck', keep: kept });
    expect(host.last('room')!.decksReady).toEqual([true, false]);
    expect(host.last('room')!.status).toBe('waiting');
    expect(host.last('error')).toBeUndefined();
  });

  it('deals from exactly the kept cards once both decks are in', () => {
    const { host, guest } = seatedPair();
    const keptHost = buildDeck(0)
      .filter((c) => c.rank !== 'K')
      .map((c) => c.id);
    hub.handle(host, { t: 'deck', keep: keptHost });
    expect(host.last('room')!.status).toBe('building'); // still waiting on guest
    hub.handle(guest, { t: 'deck', keep: buildDeck(1).map((c) => c.id) });

    const state = host.last('state')!.state as RedactedState;
    expect(state.players[0].hand!.some((c) => c.rank === 'K')).toBe(false);
    expect(host.last('room')!.status).toBe('playing');
  });

  it('rejects a deck under the minimum size', () => {
    const { host } = seatedPair();
    const tooFew = buildDeck(0).slice(0, 29).map((c) => c.id);
    hub.handle(host, { t: 'deck', keep: tooFew });
    expect(host.last('error')!.message).toMatch(/at least 30/);
    expect(host.last('room')!.decksReady).toEqual([false, false]);
  });

  it('rejects an id that is not one of the seat’s own cards', () => {
    const { host } = seatedPair();
    const forged = buildDeck(0).slice(0, 29).map((c) => c.id);
    forged.push('p1:AS'); // belongs to the other seat
    hub.handle(host, { t: 'deck', keep: forged });
    expect(host.last('error')!.message).toMatch(/no such card/);
  });

  it('rejects a second submission from the same seat', () => {
    const { host } = seatedPair();
    hub.handle(host, { t: 'deck', keep: buildDeck(0).map((c) => c.id) });
    hub.handle(host, { t: 'deck', keep: buildDeck(0).map((c) => c.id) });
    expect(host.last('error')!.message).toMatch(/already/);
  });

  it('never lets a deck arrive after the match has been dealt', () => {
    const { host } = pair();
    hub.handle(host, { t: 'deck', keep: buildDeck(0).map((c) => c.id) });
    expect(host.last('error')!.message).toMatch(/already been dealt/);
  });
});

describe('deck modes', () => {
  it('defaults to deck building when a create frame names no mode', () => {
    const host = open();
    hub.handle(host, { t: 'create' });
    expect(host.last('room')!.mode).toBe('build');
  });

  it('tells every seat the mode, so a joiner learns it without being told', () => {
    const host = open();
    hub.handle(host, { t: 'create', mode: 'double' });
    const guest = open();
    hub.handle(guest, { t: 'join', code: host.last('seated')!.code });
    expect(guest.last('room')!.mode).toBe('double');
  });

  it('accepts a doubled deck at a double table', () => {
    const host = open();
    hub.handle(host, { t: 'create', mode: 'double' });
    const keep = buildPool(0, 'double').map((c) => c.id);
    expect(keep).toHaveLength(108);
    hub.handle(host, { t: 'deck', keep });
    expect(host.last('error')).toBeUndefined();
    expect(host.last('room')!.decksReady).toEqual([true, false]);
  });

  it('refuses a doubled deck at a table that is not playing with one', () => {
    const host = open();
    hub.handle(host, { t: 'create', mode: 'build' });
    hub.handle(host, { t: 'deck', keep: buildPool(0, 'double').map((c) => c.id) });
    expect(host.last('error')!.message).toMatch(/no such card/);
  });

  it('deals the AI the mode’s whole pool, both at the table and on a rematch', () => {
    const host = open();
    hub.handle(host, { t: 'create', bot: 'easy', mode: 'double' });
    const code = host.last('seated')!.code;
    expect(store.get(code)!.decks[1]).toHaveLength(108);

    hub.handle(host, { t: 'deck', keep: buildPool(0, 'double').map((c) => c.id) });
    while (store.get(code)!.state!.phase !== 'over') {
      const state = store.get(code)!.state!;
      if (state.turn === 0) {
        hub.handle(host, { t: 'move', move: listLegalMoves(state, 0)[0]! });
      } else if (!flushBot()) break;
    }
    hub.handle(host, { t: 'rematch' });
    expect(store.get(code)!.decks[1]).toHaveLength(108);
  });
});

describe('redaction', () => {
  it('never puts the opponent’s hand or deck order on the wire', () => {
    const { host, guest } = pair();
    for (const [connection, seat] of [
      [host, 0],
      [guest, 1],
    ] as const) {
      const state = connection.last('state')!.state as RedactedState;
      const opponent = state.players[seat === 0 ? 1 : 0];
      expect(opponent.hand).toBeNull();
      expect(opponent.handCount).toBe(8);
      expect(state.players[seat].hand).toHaveLength(8);
      // Deck contents are a count and nothing more.
      expect(opponent).not.toHaveProperty('deck');
      expect(JSON.stringify(connection.received)).not.toContain('"deck"');
    }
  });

  it('anonymises the opponent’s draws in the event log', () => {
    const { host, guest } = pair();
    const state = host.last('state')!.state as RedactedState;
    // Play through the opening so a draw actually happens.
    for (let i = 0; i < 8; i++) {
      const room = store.get(host.last('seated')!.code)!;
      const turn = room.state!.turn;
      const move = listLegalMoves(room.state!, turn)[0]!;
      hub.handle(turn === 0 ? host : guest, { t: 'move', move });
    }
    const drawEvents = guest.received
      .filter((m) => m.t === 'state')
      .flatMap((m) => (m as { events: Array<{ type: string; seat?: number; cardId?: string }> }).events)
      .filter((e) => e.type === 'draw' && e.seat === 0);
    for (const event of drawEvents) expect(event.cardId).toBe('hidden');
    expect(state.seat).toBe(0);
  });
});

describe('move validation', () => {
  it('rejects an illegal intent and resyncs rather than applying it', () => {
    const { host } = pair();
    const room = store.get(host.last('seated')!.code)!;
    const before = JSON.stringify(room.state);
    hub.handle(host, {
      t: 'move',
      move: { type: 'play', cardId: 'p0:NOPE', target: { seat: 0, caravan: 0 } },
    });
    const error = host.last('error')!;
    expect(error.resync).toBe(true);
    expect(JSON.stringify(room.state)).toBe(before);
  });

  it('rejects a move made out of turn', () => {
    const { host, guest } = pair();
    const room = store.get(host.last('seated')!.code)!;
    const idle = room.state!.turn === 0 ? guest : host;
    const seat = room.state!.turn === 0 ? 1 : 0;
    hub.handle(idle, {
      t: 'move',
      move: {
        type: 'play',
        cardId: room.state!.players[seat].hand[0]!.id,
        target: { seat, caravan: 0 },
      },
    });
    expect(idle.last('error')!.message).toMatch(/not your turn/);
  });

  it('records every applied move for deterministic replay', () => {
    const { host, guest } = pair();
    const room = store.get(host.last('seated')!.code)!;
    const turn = room.state!.turn;
    // Room seeds are random, so the move has to be chosen from what is actually
    // legal rather than assuming anything about the deal.
    const move = listLegalMoves(room.state!, turn)[0]!;
    hub.handle(turn === 0 ? host : guest, { t: 'move', move });
    expect(room.moves).toEqual([{ seat: turn, move }]);
    expect(room.seed).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('reconnect', () => {
  it('restores a seat from its token and resends a full snapshot', () => {
    const { host, code } = pair();
    const token = host.last('seated')!.token;
    hub.disconnect(host);

    const refreshed = open();
    hub.handle(refreshed, { t: 'resume', token });
    expect(refreshed.last('seated')).toMatchObject({ code, seat: 0 });
    expect(refreshed.last('state')).toBeDefined();
    expect(refreshed.last('room')!.present).toEqual([true, true]);
  });

  it('tells the opponent a reconnect window is running', () => {
    const { host, guest } = pair();
    hub.disconnect(host);
    const room = guest.last('room')!;
    expect(room.present).toEqual([false, true]);
    expect(room.reconnectDeadline).toBe(now + NET.RECONNECT_GRACE_MS);
  });

  it('refuses a forged token', () => {
    const { host } = pair();
    const token = host.last('seated')!.token;
    const forged = `${token.slice(0, -1)}${token.at(-1) === 'A' ? 'B' : 'A'}`;
    const attacker = open();
    hub.handle(attacker, { t: 'resume', token: forged });
    expect(attacker.last('error')!.message).toMatch(/not valid/);
    expect(attacker.last('seated')).toBeUndefined();
  });

  it('ends the match once the grace window expires', () => {
    const { host, guest } = pair();
    hub.disconnect(host);
    now += NET.RECONNECT_GRACE_MS + 1;
    hub.tick();
    expect(guest.last('ended')!.reason).toBe('abandoned');
    expect(store.get(guest.last('seated')!.code)).toBeUndefined();
  });

  it('does not abandon a match while the player is still inside the window', () => {
    const { host, guest } = pair();
    hub.disconnect(host);
    now += NET.RECONNECT_GRACE_MS - 1000;
    hub.tick();
    expect(guest.last('ended')).toBeUndefined();
  });
});

/**
 * What a host tab needs beyond what the old server did: opening under a code it
 * already claimed on the broker, coming back from a refresh, and taking the
 * table down with it when the host leaves.
 */
describe('browser host', () => {
  it('opens a room under the code it is handed', () => {
    const host = open();
    hub.host(host, { code: 'QWERTY', mode: 'classic' });
    expect(host.last('seated')).toMatchObject({ code: 'QWERTY', seat: 0 });
    expect(store.get('QWERTY')!.mode).toBe('classic');
  });

  it('refuses a code that is already open', () => {
    hub.host(open(), { code: 'QWERTY' });
    const second = open();
    hub.host(second, { code: 'QWERTY' });
    expect(second.last('error')!.message).toMatch(/already open/);
  });

  it('puts a saved room back, with both seats reclaimable by token', () => {
    const { host, guest, code } = pair();
    reload(code);

    const back = open();
    hub.handle(back, { t: 'resume', token: host.last('seated')!.token });
    expect(back.last('seated')).toMatchObject({ code, seat: 0 });
    expect(back.last('state')).toBeDefined();
    // The guest has not come back yet, and is given the usual window to.
    expect(back.last('room')!.present).toEqual([true, false]);
    expect(back.last('room')!.reconnectDeadline).toBe(now + NET.RECONNECT_GRACE_MS);

    const guestBack = open();
    hub.handle(guestBack, { t: 'resume', token: guest.last('seated')!.token });
    expect(guestBack.last('seated')).toMatchObject({ code, seat: 1 });
  });

  it('re-seats the AI in a restored solo room, and it carries on playing', () => {
    const host = open();
    hub.handle(host, { t: 'create', bot: 'easy', mode: 'classic' });
    const code = host.last('seated')!.code;
    hub.handle(host, { t: 'deck', keep: buildPool(0, 'classic').map((c) => c.id) });
    reload(code);

    const room = store.get(code)!;
    // Only the human seat is waiting on a reconnect; the AI never left.
    expect(room.disconnectedAt).toEqual([now, null]);

    const back = open();
    hub.handle(back, { t: 'resume', token: host.last('seated')!.token });
    if (room.state!.turn === 0) {
      hub.handle(back, { t: 'move', move: listLegalMoves(room.state!, 0)[0]! });
    }
    const played = room.moves.length;
    expect(flushBot()).toBe(true);
    expect(store.get(code)!.moves.length).toBe(played + 1);
  });

  it('ends the table for everyone when the host closes it', () => {
    const { host, guest, code } = pair();
    const token = guest.last('seated')!.token;
    hub.end(code, 'opponent-left');
    expect(guest.last('ended')!.reason).toBe('opponent-left');
    expect(host.last('ended')!.reason).toBe('opponent-left');
    expect(store.get(code)).toBeUndefined();

    // The seat's secret goes with the room.
    const late = open();
    hub.handle(late, { t: 'resume', token });
    expect(late.last('error')!.message).toMatch(/not valid/);
  });
});

describe('idle sweep', () => {
  it('collects rooms with no activity', () => {
    const { host, code } = pair();
    now += NET.IDLE_SWEEP_MS + 1;
    hub.tick();
    expect(store.get(code)).toBeUndefined();
    expect(host.last('ended')!.reason).toBe('idle');
  });
});

describe('protocol validation', () => {
  it('rejects malformed client messages at the boundary', () => {
    expect(ClientMessage.safeParse({ t: 'join', code: 'toolong' }).success).toBe(false);
    expect(ClientMessage.safeParse({ t: 'nope' }).success).toBe(false);
    expect(
      ClientMessage.safeParse({ t: 'move', move: { type: 'play', cardId: 'x' } }).success,
    ).toBe(false);
    expect(ClientMessage.safeParse({ t: 'join', code: 'ABCDEF' }).success).toBe(true);
  });
});

describe('rematch', () => {
  /** Plays a seated pair's match out to a result, first legal move each turn.
      The ply cap guarantees this terminates however badly both sides play. */
  function playOut(host: TestConnection, guest: TestConnection, code: string): void {
    for (let turn = 0; turn < 400; turn++) {
      const room = store.get(code);
      if (!room?.state || room.state.phase === 'over') break;
      const [move] = listLegalMoves(room.state, room.state.turn);
      if (!move) break;
      hub.handle(room.state.turn === 0 ? host : guest, { t: 'move', move });
    }
    expect(store.get(code)!.state!.phase).toBe('over');
  }

  it('waits for both seats before redealing', () => {
    const { host, guest, code } = pair();
    playOut(host, guest, code);

    hub.handle(host, { t: 'rematch' });
    expect(host.last('room')!.rematch).toEqual([true, false]);
    // The table is still up — a decided match is not a gone room.
    expect(host.last('room')!.status).toBe('playing');
    expect(store.get(code)!.state!.phase).toBe('over');

    hub.handle(guest, { t: 'rematch' });
    const room = guest.last('room')!;
    expect(room.status).toBe('building');
    expect(room.code).toBe(code);
    expect(room.decksReady).toEqual([false, false]);
    expect(room.rematch).toEqual([false, false]);
    expect(store.get(code)!.state).toBeNull();
  });

  it('deals a different match, keeping the same table and seats', () => {
    const { host, guest, code } = pair();
    const first = store.get(code)!.seed;
    playOut(host, guest, code);
    hub.handle(host, { t: 'rematch' });
    hub.handle(guest, { t: 'rematch' });

    expect(store.get(code)!.seed).not.toBe(first);
    expect(store.get(code)!.moves).toEqual([]);
    submitFullDecks(host, guest);
    expect(host.last('room')!.status).toBe('playing');
    expect((host.last('state')!.state as RedactedState).result).toBeNull();
  });

  it('restarts a solo table on the host’s word alone — the AI always plays again', () => {
    const host = open();
    hub.handle(host, { t: 'create', bot: 'medium' });
    const code = host.last('seated')!.code;
    hub.handle(host, { t: 'deck', keep: buildDeck(0).map((c) => c.id) });
    for (let turn = 0; turn < 400; turn++) {
      const room = store.get(code);
      if (!room?.state || room.state.phase === 'over') break;
      if (room.state.turn === 0) {
        hub.handle(host, { t: 'move', move: listLegalMoves(room.state, 0)[0]! });
      } else {
        flushBot();
      }
    }

    hub.handle(host, { t: 'rematch' });
    const room = host.last('room')!;
    expect(room.status).toBe('building');
    // The AI's 54 is back in place, so the host's own deck is all that is owed.
    expect(room.decksReady).toEqual([false, true]);
  });

  it('refuses a rematch of a match that is still going', () => {
    const { host } = pair();
    hub.handle(host, { t: 'rematch' });
    expect(host.last('error')!.message).toMatch(/still going/);
  });
});

describe('single player', () => {
  /** A solo table: the host, and the AI already sitting in seat 1. */
  function solo(): { host: TestConnection; code: string } {
    const host = open();
    hub.handle(host, { t: 'create', bot: 'medium' });
    return { host, code: host.last('seated')!.code };
  }

  it('fills the second seat itself, so only the host still owes a deck', () => {
    const { host } = solo();
    const room = host.last('room')!;
    expect(room.status).toBe('building');
    expect(room.present).toEqual([true, true]);
    expect(room.decksReady).toEqual([false, true]);
  });

  it('deals as soon as the host’s deck lands, with no second connection', () => {
    const { host } = solo();
    expect(host.last('state')).toBeUndefined();
    hub.handle(host, { t: 'deck', keep: buildDeck(0).map((c) => c.id) });
    expect(host.last('state')).toBeDefined();
    expect(host.last('room')!.status).toBe('playing');
  });

  it('refuses a second human at the table', () => {
    const { code } = solo();
    const intruder = open();
    hub.handle(intruder, { t: 'join', code });
    expect(intruder.last('error')!.message).toBe('that room is full');
  });

  it('plays a whole match against the host to a decided result', () => {
    const { host, code } = solo();
    hub.handle(host, { t: 'deck', keep: buildDeck(0).map((c) => c.id) });

    // The host plays the first legal move it is offered; the AI answers on its
    // own timer. Between them the match has to reach a result and never stall.
    for (let turn = 0; turn < 400; turn++) {
      const room = store.get(code);
      if (!room?.state || room.state.phase === 'over') break;
      if (room.state.turn === 0) {
        const [move] = listLegalMoves(room.state, 0);
        expect(move).toBeDefined();
        hub.handle(host, { t: 'move', move: move! });
      } else {
        // The AI owes a move here, and the only thing that can produce one is
        // the timer the hub queued for it.
        expect(flushBot()).toBe(true);
      }
    }

    const state = host.last('state')!.state as RedactedState;
    expect(state.result).not.toBeNull();
    // Every AI move went through the ordinary move path, so the replay record
    // holds both sides of the match, not just the host's half.
    const moves = store.get(code)!.moves;
    expect(moves.filter((m) => m.seat === 1).length).toBeGreaterThan(3);
    expect(moves.some((m) => m.seat === 0)).toBe(true);
  });

  it('never queues a move while it is the host’s turn', () => {
    const { host, code } = solo();
    hub.handle(host, { t: 'deck', keep: buildDeck(0).map((c) => c.id) });
    while (store.get(code)!.state!.turn === 1) flushBot();
    expect(pending).toHaveLength(0);
  });
});
