import type { Card, GameEvent, MatchResult, MatchState, Phase, Seat } from '@caravan/rules';

/**
 * The board is public; hands and deck order are not. These are the only shapes
 * that ever reach the wire.
 */
export interface RedactedSlot {
  card: Card;
  attached: Card[];
}

export interface RedactedCaravan {
  slots: RedactedSlot[];
}

export interface RedactedPlayer {
  caravans: RedactedCaravan[];
  deckCount: number;
  handCount: number;
  /** Populated only for the seat receiving this snapshot. */
  hand: Card[] | null;
  discardCount: number;
}

export interface RedactedState {
  seat: Seat;
  phase: Phase;
  turn: Seat;
  ply: number;
  players: [RedactedPlayer, RedactedPlayer];
  result: MatchResult | null;
  turnDeadline: number | null;
}

/**
 * The single choke-point by which match state reaches a client. Nothing else in
 * the table may serialize a MatchState — if a field is secret, it is dropped
 * here or it leaks.
 */
export function redactFor(seat: Seat, state: MatchState): RedactedState {
  const players = ([0, 1] as Seat[]).map((s): RedactedPlayer => {
    const p = state.players[s];
    return {
      caravans: p.caravans.map((c) => ({
        slots: c.slots.map((slot) => ({ card: slot.card, attached: [...slot.attached] })),
      })),
      deckCount: p.deck.length,
      handCount: p.hand.length,
      hand: s === seat ? [...p.hand] : null,
      discardCount: p.discard.length,
    };
  }) as [RedactedPlayer, RedactedPlayer];

  return {
    seat,
    phase: state.phase,
    turn: state.turn,
    ply: state.ply,
    players,
    result: state.result,
    turnDeadline: state.turnDeadline,
  };
}

/**
 * The mirror of `redactFor`: rebuilds a MatchState the rules engine will accept,
 * so the client can ask the shared engine which moves are legal without a
 * round-trip. Which cards the opponent holds is genuinely unknown, so their
 * hand — like their deck and discard — becomes placeholders. None of it affects
 * the legality of a move by the receiving seat. This is advisory UI only; the
 * table re-validates everything anyway.
 *
 * The placeholders are of the right *length*, and that matters: `handCount` is
 * public, and a rule that asks whether a player has run out of cards must not
 * read a redacted hand as an empty one. That is the difference between "I know
 * nothing about these cards" and "there are no cards", and hydrating the
 * opponent's hand as `[]` conflated the two — every move the client predicted
 * ended the match on the spot.
 */
export function hydrateForClient(view: RedactedState): MatchState {
  const players = ([0, 1] as Seat[]).map((s) => {
    const p = view.players[s];
    return {
      deck: Array.from({ length: p.deckCount }, (_, i) => ({
        id: `p${s}:unknown-deck-${i}`,
        rank: '5' as const,
        suit: 'S' as const,
        owner: s,
      })),
      hand:
        p.hand ??
        Array.from({ length: p.handCount }, (_, i) => ({
          id: `p${s}:unknown-hand-${i}`,
          rank: '5' as const,
          suit: 'S' as const,
          owner: s,
        })),
      discard: Array.from({ length: p.discardCount }, (_, i) => ({
        id: `p${s}:unknown-discard-${i}`,
        rank: '5' as const,
        suit: 'S' as const,
        owner: s,
      })),
      caravans: p.caravans.map((c) => ({
        slots: c.slots.map((slot) => ({ card: slot.card, attached: [...slot.attached] })),
      })),
    };
  }) as MatchState['players'];

  return {
    seed: 'client-view',
    rngCalls: 0,
    players,
    turn: view.turn,
    phase: view.phase,
    ply: view.ply,
    // Only used to gate opening placements, which the phase already covers.
    openingPlaced: [3, 3],
    result: view.result,
    turnDeadline: view.turnDeadline,
  };
}

/**
 * Events name card ids. A draw reveals which card entered a hand, so the
 * opponent's draws are anonymised; every other event is already public.
 */
export function redactEvents(seat: Seat, events: GameEvent[]): GameEvent[] {
  return events.map((event) =>
    event.type === 'draw' && event.seat !== seat
      ? { ...event, cardId: 'hidden' }
      : event,
  );
}
