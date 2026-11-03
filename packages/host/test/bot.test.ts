import {
  applyMove,
  buildDeck,
  buildPool,
  cardValue,
  isNumberCard,
  listLegalMoves,
  scenario,
  type MatchState,
  type Move,
} from '@caravan/rules';
import { describe, expect, it } from 'vitest';
import { bestReply, chooseMove, evaluate, type OpponentModel } from '../src/bot.js';

const DIFFICULTIES = ['easy', 'medium', 'hard', 'extreme'] as const;

/** The same position, but far enough along that the bot's RNG stream differs. */
function atPly(state: MatchState, ply: number): MatchState {
  return { ...state, ply };
}

/** What the bot does across a spread of RNG positions, for the random cases. */
function overManyTurns(
  state: MatchState,
  difficulty: (typeof DIFFICULTIES)[number],
  table?: OpponentModel,
  // A searching difficulty costs a real fraction of a second per move, so the
  // tests that compare two whole runs of them ask for fewer.
  count = 40,
): Move[] {
  // Ply must stay even so it remains seat 1's turn as far as the engine cares;
  // only the RNG skip actually changes.
  return Array.from(
    { length: count },
    (_, i) => chooseMove(atPly(state, 10 + i * 2), 1, difficulty, table)!,
  );
}

/** The two runs those comparisons are made of. */
function overSixTurns(
  state: MatchState,
  difficulty: (typeof DIFFICULTIES)[number],
  table?: OpponentModel,
): Move[] {
  return overManyTurns(state, difficulty, table, 6);
}

/** Two opponent decks with nothing in common, for the pair of tests about which
 *  difficulty may look at one. Same position, same seed, same hand size to
 *  sample — only the pool the hidden cards are drawn from differs. */
const ALL_FACES = buildDeck(0)
  .filter((c) => !isNumberCard(c) || cardValue(c) > 8)
  .map((c) => c.id);
const ALL_NUMBERS = buildDeck(0).filter(isNumberCard).map((c) => c.id);

function deckKnowledgeState(): MatchState {
  return scenario({
    turn: 1,
    p0: { caravans: ['7S,9H', '5H', ''], hand: '2D 3D' },
    p1: { caravans: ['6S,8S', '6H,8H', ''], hand: '10C 5D JS', deckSize: 10 },
  });
}

describe('the bot', () => {
  it('only ever returns a move the engine already called legal', () => {
    const state = scenario({
      turn: 1,
      p0: { caravans: ['9S,10S', '5H', ''] },
      p1: { caravans: ['4S,7S', '', ''], hand: '5S 10S JC KD QH', deckSize: 10 },
    });
    for (const difficulty of DIFFICULTIES) {
      const legal = new Set(listLegalMoves(state, 1).map((m) => JSON.stringify(m)));
      for (const move of overManyTurns(state, difficulty)) {
        expect(legal.has(JSON.stringify(move))).toBe(true);
      }
    }
  });

  it('picks the same move twice from the same position', () => {
    const state = scenario({
      turn: 1,
      p0: { caravans: ['9S,10S', '', ''] },
      p1: { caravans: ['4S,7S', '', ''], hand: '5S 10S JC', deckSize: 10 },
    });
    for (const difficulty of DIFFICULTIES) {
      expect(chooseMove(state, 1, difficulty)).toEqual(chooseMove(state, 1, difficulty));
    }
  });

  it('never disbands a caravan that was doing fine, at any difficulty', () => {
    const state = scenario({
      turn: 1,
      p0: { caravans: ['9S', '', ''] },
      p1: { caravans: ['5H,7S', '', ''], hand: '5S 10S JC KD', deckSize: 10 },
    });
    expect(listLegalMoves(state, 1).some((m) => m.type === 'disband')).toBe(true);
    for (const difficulty of DIFFICULTIES) {
      for (const move of overManyTurns(state, difficulty)) {
        expect(move.type).not.toBe('disband');
      }
    }
  });

  it('does disband one that can no longer sell, at any difficulty', () => {
    // No hand at all, so disbanding the overburdened caravan is the only move
    // left on the table — the gate has to let it through or the bot is stuck.
    const state = scenario({
      turn: 1,
      p0: { caravans: ['9S', '', ''] },
      p1: { caravans: ['10S,9S,8S', '', ''] },
    });
    for (const difficulty of DIFFICULTIES) {
      expect(chooseMove(state, 1, difficulty)).toEqual({ type: 'disband', caravan: 0 });
    }
  });

  describe('easy', () => {
    it('never touches the opponent’s side of the table', () => {
      const state = scenario({
        turn: 1,
        p0: { caravans: ['9S,10S,5S', '7H', ''] },
        p1: { caravans: ['4S,7S', '', ''], hand: 'JC KD QH 5S', deckSize: 10 },
      });
      // The offensive plays are on offer; easy simply declines them.
      expect(listLegalMoves(state, 1).some((m) => m.type === 'play' && m.target.seat === 0)).toBe(
        true,
      );
      for (const move of overManyTurns(state, 'easy')) {
        if (move.type === 'play') expect(move.target.seat).toBe(1);
      }
    });

    it('takes the play that lands in the sell range over the one that overshoots', () => {
      // 19 on the table: the 5 makes 24, the 10 makes 29 and is unsellable.
      const state = scenario({
        turn: 1,
        p0: { caravans: ['9S', '', ''] },
        p1: { caravans: ['4S,7S,8S', '', ''], hand: '5S 10S', deckSize: 10 },
      });
      expect(chooseMove(state, 1, 'easy')).toEqual({
        type: 'play',
        cardId: 'p1:5S#0',
        target: { seat: 1, caravan: 0 },
      });
    });

    it('Jacks its own overburdened caravan back down', () => {
      // 27 — over the range. Dropping the 8 is the closest it gets to the band.
      const state = scenario({
        turn: 1,
        p0: { caravans: ['9S', '', ''] },
        p1: { caravans: ['10S,9S,8S', '', ''], hand: 'JC', deckSize: 10 },
      });
      expect(chooseMove(state, 1, 'easy')).toEqual({
        type: 'play',
        cardId: 'p1:JC#0',
        target: { seat: 1, caravan: 0, slot: 2 },
      });
    });

    it('Kings the card that lands it in the band, not the one that overshoots', () => {
      // 17 on the table: doubling the 7 makes 24, doubling the 10 makes 27.
      const state = scenario({
        turn: 1,
        p0: { caravans: ['9S', '', ''] },
        p1: { caravans: ['10S,7S', '', ''], hand: 'KC', deckSize: 10 },
      });
      expect(chooseMove(state, 1, 'easy')).toEqual({
        type: 'play',
        cardId: 'p1:KC#0',
        target: { seat: 1, caravan: 0, slot: 1 },
      });
    });
  });

  describe('medium', () => {
    it('Jacks the opponent’s caravan when it is the biggest swing available', () => {
      const state = scenario({
        turn: 1,
        p0: { caravans: ['10S,9S,5S', '', ''] },
        p1: { caravans: ['4S', '', ''], hand: 'JC', deckSize: 10 },
      });
      expect(chooseMove(state, 1, 'medium')).toEqual({
        type: 'play',
        cardId: 'p1:JC#0',
        target: { seat: 0, caravan: 0, slot: 0 },
      });
    });

    it('Kings the opponent only when the doubling pushes them out of range', () => {
      // Their 24 is about to sell; doubling the 10 takes it to 34 and kills it.
      const sellable = scenario({
        turn: 1,
        p0: { caravans: ['10S,9S,5S', '', ''] },
        p1: { caravans: ['4S', '', ''], hand: 'KC', deckSize: 10 },
      });
      // Which card of theirs it doubles is not asserted: every one of them puts
      // that caravan past the cap, and past the cap is past the cap — the bot
      // scores them alike on purpose, so the tie-break is the RNG's.
      for (const move of overManyTurns(sellable, 'medium')) {
        expect(move).toMatchObject({
          type: 'play',
          cardId: 'p1:KC#0',
          target: { seat: 0, caravan: 0 },
        });
      }
    });

    it('keeps the King for itself when giving it away would only help them', () => {
      // Their 12 is nowhere near the range — doubling anything of theirs is a
      // gift. Its own 17 becomes 24.
      const state = scenario({
        turn: 1,
        p0: { caravans: ['5S,7S', '', ''] },
        p1: { caravans: ['10S,7S', '', ''], hand: 'KC', deckSize: 10 },
      });
      expect(chooseMove(state, 1, 'medium')).toEqual({
        type: 'play',
        cardId: 'p1:KC#0',
        target: { seat: 1, caravan: 0, slot: 1 },
      });
    });
  });

  describe('hard', () => {
    it('picks the play that wins its lane outright over one that only lands in range, even though both make the same 24', () => {
      // Playing the 10 on lane 0 makes 24 — in range, but p0's lane 0 is
      // already a 26, so it only gets outbid. Playing it on lane 1 also makes
      // 24, and p0's lane 1 is a building 5, so that one actually sells. A
      // scorer that just sums its own board (medium's positionScore) rates a
      // 24 the same wherever it lands; the lane-aware evaluation knows one of
      // these is a win and the other is nothing.
      // p0 holds cards deliberately: with an empty hand every move here wins on
      // the spot by exhaustion, all candidates evaluate to the same win, and the
      // choice comes down to the tie-break rather than to the lanes.
      const state = scenario({
        turn: 1,
        p0: { caravans: ['7S,9H,10D', '5H', ''], hand: '2D 3D' },
        p1: { caravans: ['6S,8S', '6H,8H', ''], hand: '10C', deckSize: 10 },
      });
      expect(chooseMove(state, 1, 'hard')).toEqual({
        type: 'play',
        cardId: 'p1:10C#0',
        target: { seat: 1, caravan: 1 },
      });
    });

    it('does not need to know the opponent’s actual hand to decide', () => {
      // Same board and the same *size* of opponent hand, but different cards
      // in it. A bot that peeked would be free to react to the difference;
      // this one only ever samples from what's publicly still possible, so
      // the choice must come out identical either way.
      const base = {
        turn: 1 as const,
        p0: { caravans: ['7S,9H,10D', '5H', ''] },
        p1: { caravans: ['6S,8S', '6H,8H', ''], hand: '10C', deckSize: 10 },
      };
      const stateA = scenario({ ...base, p0: { ...base.p0, hand: '2D 3D' } });
      const stateB = scenario({ ...base, p0: { ...base.p0, hand: 'KH AC' } });
      expect(chooseMove(stateA, 1, 'hard')).toEqual(chooseMove(stateB, 1, 'hard'));
    });

    it('does not read the deck the opponent built, however different it is', () => {
      // The half of `OpponentModel` `hard` is not allowed to look at. Two
      // opponent decks with nothing in common are handed to it in the same
      // position; a difficulty that read them would be free to play them
      // differently, and this one has to be blind to the difference. The
      // sibling `extreme` test is the same setup with the opposite assertion.
      const state = deckKnowledgeState();
      expect(overSixTurns(state, 'hard', { mode: 'build', deck: ALL_FACES })).toEqual(
        overSixTurns(state, 'hard', { mode: 'build', deck: ALL_NUMBERS }),
      );
    });

    it('plays a doubled deck without tripping over the second copy of a card', () => {
      const state = scenario({
        turn: 1,
        p0: { caravans: ['7S,9H,10D', '5H', ''] },
        p1: { caravans: ['6S,8S', '6H,8H', ''], hand: '10C 5D', deckSize: 10 },
      });
      const doubled = buildPool(0, 'double').map((c) => c.id);
      const legal = new Set(listLegalMoves(state, 1).map((m) => JSON.stringify(m)));
      for (let i = 0; i < 6; i++) {
        const move = chooseMove(atPly(state, 10 + i * 2), 1, 'hard', {
          mode: 'double',
          deck: doubled,
        })!;
        expect(legal.has(JSON.stringify(move))).toBe(true);
      }
    });

    it('does not sell its own last caravan when that hands the opponent the other two and the match', () => {
      // p0 already has lanes 0 and 1 locked up (24 each, against p1's 3s) —
      // those two tracks are decided in p0's favor and nothing this turn can
      // undo that. Lane 2 is still open: p0 sits at a harmless 5, and p1 is
      // one card away from 24. Taking it would decide all three tracks at
      // once and hand p0 the match 2-1 — worse than leaving it alone.
      const state = scenario({
        turn: 1,
        p0: { caravans: ['9S,8H,7D', '9C,8D,7S', '5S'] },
        p1: { caravans: ['3S', '3H', '6S,8S'], hand: '10C', deckSize: 10 },
      });
      const move = chooseMove(state, 1, 'hard')!;
      const after = applyMove(state, 1, move).state;
      expect(after.result).not.toEqual({ kind: 'winner', seat: 0, reason: 'tracks' });
    });

    it('does not spend a face card on a caravan already past the sell cap', () => {
      // p0's lane 0 is a 37 with a King already on the 10 — dead, and nothing
      // done to it changes that. Every offensive card in hand has that lane as
      // a legal target; all of them are pure waste, so the bot has to leave it
      // alone rather than take the "gain" of pushing it further over.
      const state = scenario({
        turn: 1,
        p0: { caravans: ['10S+KS,9H,8D', '5H', ''], hand: '2D 3D' },
        p1: { caravans: ['6S,8S', '', ''], hand: 'KC QH 5D', deckSize: 10 },
      });
      for (const move of overManyTurns(state, 'hard')) {
        const wasted =
          move.type === 'play' && move.target.seat === 0 && move.target.caravan === 0;
        expect(wasted).toBe(false);
      }
    });

    it('pitches its least useful card rather than burn a Jack on nothing', () => {
      // Its own lanes are as good as they get and there is nothing worth doing
      // to p0's dead 37, so no play changes the position. The choice is then
      // purely about what leaves the hand: the spare 2, not the Jack.
      const state = scenario({
        turn: 1,
        p0: { caravans: ['10S,9H,8D,10C', '', ''], hand: '2H' },
        p1: { caravans: ['9S,10S,5S', '', ''], hand: 'JC 2D', deckSize: 10 },
      });
      for (const move of overManyTurns(state, 'hard')) {
        if (move.type === 'discard') expect(move.cardId).toContain('2D');
        else if (move.type === 'play') expect(move.cardId).not.toContain('JC');
      }
    });

    it('still only ever plays a legal move once the opponent’s board is empty', () => {
      // Nothing to sample against and no opposing lane to compare with — the
      // search has to degrade gracefully rather than throw.
      const state = scenario({
        turn: 1,
        p0: { caravans: ['', '', ''] },
        p1: { caravans: ['9S', '', ''], hand: '5S JC', deckSize: 10 },
      });
      const legal = new Set(listLegalMoves(state, 1).map((m) => JSON.stringify(m)));
      expect(legal.has(JSON.stringify(chooseMove(state, 1, 'hard')))).toBe(true);
    });
  });

  describe('the fixed evaluation', () => {
    it('rates a sale a single Jack cannot undo above one it can', () => {
      // The same 24, sold against the same opposing 5, composed two ways. The
      // first stands on a King-doubled 10 — twenty of itself in one slot, and
      // a single Jack takes the sale with it. The second is spread over four
      // cards and loses at most a 7. `caravanValue` cannot tell them apart.
      const brittle = scenario({
        turn: 1,
        p0: { caravans: ['5S', '', ''], hand: '2D' },
        p1: { caravans: ['10S+KS,4H', '', ''], hand: '3C', deckSize: 10 },
      });
      const sturdy = scenario({
        turn: 1,
        p0: { caravans: ['5S', '', ''], hand: '2D' },
        p1: { caravans: ['6S,7H,7S,4H', '', ''], hand: '3C', deckSize: 10 },
      });
      expect(evaluate(sturdy, 1)).toBeGreaterThan(evaluate(brittle, 1));
    });

    it('rates the second of three tracks far above what the lane alone is worth', () => {
      // p1 holds lane 0 either way. Lane 1 is a 21 that sells — the second
      // track, and so the match once the third resolves — against a 20 that is
      // one short of anything. A per-lane sum prices that gap at the lane's own
      // worth, about 150; holding two of three has to be worth more than that,
      // or the search will trade the second track for a fatter caravan.
      const majority = scenario({
        turn: 1,
        p0: { caravans: ['4S', '5H', ''], hand: '2D' },
        p1: { caravans: ['9H,10S,5S', '10D,8S,3H', ''], hand: '3C', deckSize: 10 },
      });
      const oneShort = scenario({
        turn: 1,
        p0: { caravans: ['4S', '5H', ''], hand: '2D' },
        p1: { caravans: ['9H,10S,5S', '10D,8S,2H', ''], hand: '3C', deckSize: 10 },
      });
      expect(evaluate(majority, 1) - evaluate(oneShort, 1)).toBeGreaterThan(300);
    });

    it('still lets a decided match outweigh every heuristic term', () => {
      // The terms above are additive, so the guard is that none of them can
      // add up to a win — a lost match must stay worse than any board.
      const board = scenario({
        turn: 1,
        p0: { caravans: ['9S,8H,7D', '9C,8D,7S', '9D,8S,7H'] },
        p1: { caravans: ['3S', '3H', '3D'], hand: '2D', deckSize: 10 },
      });
      // `scenario` builds a position, not a played-out match, so the result is
      // set here rather than inferred — which is also the only way to be sure
      // the terminal branch is what is being measured.
      const lost: MatchState = {
        ...board,
        result: { kind: 'winner', seat: 0, reason: 'tracks' },
      };
      expect(evaluate(lost, 1)).toBeLessThan(-1000);
      expect(evaluate(board, 1)).toBeGreaterThan(evaluate(lost, 1));
    });
  });

  describe('the modelled opponent', () => {
    it('is no cheaper with its cards than the bot is with its own', () => {
      // Seat 0 to move, holding a Jack and a spare 2. p1's 37 is past saving
      // and nothing on the table can be improved, so every reply evaluates the
      // same and the choice is purely what leaves the hand. An opponent model
      // that ignored `spendCost` would happily spend the Jack, and every
      // candidate move would be judged against that softer reply.
      const state = scenario({
        turn: 0,
        p0: { caravans: ['9S,10S,5S', '', ''], hand: 'JC 2D', deckSize: 10 },
        p1: { caravans: ['10S,9H,8D,10C', '', ''], hand: '2H' },
      });
      const reply = bestReply(state, 0)!;
      expect(reply.type === 'play' && reply.cardId.includes('JC')).toBe(false);
    });
  });

  describe('extreme', () => {
    it('does model the opponent from the deck they actually built', () => {
      // The one thing it has that `hard` does not. Deck composition is private
      // at the table — the protocol tells a seat only `decksReady` — so this is
      // knowledge no human opponent could have, and it is the whole of what the
      // difficulty buys. Two very different decks must reach it as different.
      const state = deckKnowledgeState();
      expect(overSixTurns(state, 'extreme', { mode: 'build', deck: ALL_FACES })).not.toEqual(
        overSixTurns(state, 'extreme', { mode: 'build', deck: ALL_NUMBERS }),
      );
    });

    it('searches a ply deeper than hard even with nothing to read', () => {
      // The deck knowledge was measured as worth nothing on its own, so the
      // difficulty is that knowledge *and* the third ply. With no deck to read
      // the pool is identical and only the depth is left — so the two must
      // still part company somewhere over six positions.
      const state = deckKnowledgeState();
      const table = { mode: 'build' as const };
      expect(overSixTurns(state, 'extreme', table)).not.toEqual(
        overSixTurns(state, 'hard', table),
      );
    });
  });
});
