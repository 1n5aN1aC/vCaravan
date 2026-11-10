import {
  applyMove,
  createMatch,
  listLegalMoves,
  type MatchState,
  type Seat,
} from '@caravan/rules';
import { describe, expect, it } from 'vitest';
import { hydrateForClient, redactEvents, redactFor } from '../src/index.js';

function advance(state: MatchState, plies: number): MatchState {
  let next = state;
  for (let i = 0; i < plies; i++) {
    const moves = listLegalMoves(next, next.turn);
    if (moves.length === 0) break;
    next = applyMove(next, next.turn, moves[i % moves.length]!).state;
  }
  return next;
}

describe('redactFor', () => {
  it('hides the opponent’s hand and both deck orders', () => {
    const state = advance(createMatch('redact').state, 12);
    const view = redactFor(0, state);
    expect(view.players[0].hand).toHaveLength(state.players[0].hand.length);
    expect(view.players[1].hand).toBeNull();
    expect(view.players[1].handCount).toBe(state.players[1].hand.length);
    expect(JSON.stringify(view)).not.toContain(state.players[1].deck[0]!.id);
    expect(JSON.stringify(view)).not.toContain(state.players[1].hand[0]!.id);
  });

  it('keeps the whole board visible to both seats', () => {
    const state = advance(createMatch('redact').state, 12);
    for (const seat of [0, 1] as Seat[]) {
      const view = redactFor(seat, state);
      for (const s of [0, 1] as Seat[]) {
        expect(view.players[s].caravans.map((c) => c.slots.length)).toEqual(
          state.players[s].caravans.map((c) => c.slots.length),
        );
      }
    }
  });

  it('anonymises only the opponent’s draws', () => {
    const events = redactEvents(0, [
      { type: 'draw', seat: 0, cardId: 'p0:7H' },
      { type: 'draw', seat: 1, cardId: 'p1:7H' },
    ]);
    expect(events[0]).toMatchObject({ cardId: 'p0:7H' });
    expect(events[1]).toMatchObject({ cardId: 'hidden' });
  });
});

describe('hydrateForClient', () => {
  it('reproduces the table’s legal move list exactly, from redacted state', () => {
    // If these ever diverge, the client highlights moves the table rejects.
    let state = createMatch('mirror').state;
    for (let ply = 0; ply < 60 && state.phase !== 'over'; ply++) {
      const seat = state.turn;
      const authoritative = listLegalMoves(state, seat);
      const mirrored = listLegalMoves(hydrateForClient(redactFor(seat, state)), seat);
      expect(mirrored).toEqual(authoritative);
      if (authoritative.length === 0) break;
      state = applyMove(state, seat, authoritative[ply % authoritative.length]!).state;
    }
  });

  it('keeps the opponent holding as many cards as they really hold', () => {
    // Redacted is not empty. Any rule that counts a player's cards — running
    // out of them ends the match — reads this hand, and hydrating it as `[]`
    // told the client its opponent had nothing left after every single move.
    const state = advance(createMatch('counts').state, 8);
    for (const seat of [0, 1] as Seat[]) {
      const them: Seat = seat === 0 ? 1 : 0;
      const hydrated = hydrateForClient(redactFor(seat, state));
      expect(hydrated.players[them].hand).toHaveLength(state.players[them].hand.length);
      expect(hydrated.players[them].hand.length).toBeGreaterThan(0);
      // Placeholders, though — the cards themselves stay secret.
      expect(hydrated.players[them].hand.map((c) => c.id)).not.toContain(
        state.players[them].hand[0]!.id,
      );
    }
  });

  it('gives the idle seat no moves, matching the table', () => {
    const state = advance(createMatch('mirror-2').state, 8);
    const idle: Seat = state.turn === 0 ? 1 : 0;
    expect(listLegalMoves(hydrateForClient(redactFor(idle, state)), idle)).toEqual([]);
  });
});
