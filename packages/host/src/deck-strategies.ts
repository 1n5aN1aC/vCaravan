import type { Difficulty } from '@caravan/protocol';
import {
  buildPool,
  cardValue,
  createRng,
  isNumberCard,
  type Card,
  type DeckModeId,
  type Seat,
} from '@caravan/rules';

/**
 * Deck-building strategies for bots to draft from — each a filter over the
 * standard 54-card `build`-mode pool. A strategy is a rank/suit predicate, not
 * a suit-aware pick, so both seats draft identically regardless of which side
 * of the table they sit on.
 *
 * These exist to be measured, not assumed: see `deck-tournament.ts`, which
 * plays every pair of them against each other and ranks them by result. Two
 * of those tournaments settled which strategies `pickBotDeck` below draws
 * from for `hard` and `extreme` at a real table.
 */
export interface DeckStrategy {
  id: string;
  label: string;
  blurb: string;
  select: (card: Card) => boolean;
}

const inValueRange = (lo: number, hi: number) => (card: Card) =>
  isNumberCard(card) && cardValue(card) >= lo && cardValue(card) <= hi;

const isFace = (ranks: ReadonlyArray<'J' | 'Q' | 'K'>) => (card: Card) =>
  (ranks as readonly string[]).includes(card.rank);

const isJokerCard = (card: Card) => card.rank === 'JOKER';

function anyOf(...preds: Array<(card: Card) => boolean>) {
  return (card: Card) => preds.some((p) => p(card));
}

const ALL_FACES = isFace(['J', 'Q', 'K']);
const ALL_FACES_AND_JOKERS = anyOf(ALL_FACES, isJokerCard);

export const DECK_STRATEGIES: DeckStrategy[] = [
  {
    id: 'full-pool',
    label: 'Full Pool',
    blurb: 'No cuts at all — every one of the 54 cards. The control group.',
    select: () => true,
  },
  {
    id: 'low-ladder',
    label: 'Low Ladder',
    blurb:
      'Numbers A-6 plus every face card and both Jokers. Long, fine-grained ' +
      'ascending/descending runs make it easy to land a caravan exactly in the 21-26 band.',
    select: anyOf(inValueRange(1, 6), ALL_FACES_AND_JOKERS),
  },
  {
    id: 'high-roller',
    label: 'High Roller',
    blurb:
      'Numbers 6-10 plus every face card and both Jokers. As few as three cards ' +
      'can reach the sell band, pressuring a fast sale at the cost of overshooting easily.',
    select: anyOf(inValueRange(6, 10), ALL_FACES_AND_JOKERS),
  },
  {
    id: 'mid-curve',
    label: 'Mid Curve',
    blurb:
      'Numbers 3-8 plus every face card and both Jokers. Splits the difference ' +
      'between the low and high curves rather than committing to either extreme.',
    select: anyOf(inValueRange(3, 8), ALL_FACES_AND_JOKERS),
  },
  {
    id: 'full-range-thin',
    label: 'Full Range, Thin Faces',
    blurb:
      'All ten number ranks plus Jacks and Kings only. Maximum numeric ' +
      'flexibility, kept to the two face cards that remove and double.',
    select: anyOf(isNumberCard, isFace(['J', 'K'])),
  },
  {
    id: 'pure-builder',
    label: 'Pure Builder',
    blurb:
      'All ten number ranks plus Kings and Queens only, no Jacks or Jokers. ' +
      'Commits entirely to building and doubling — never disrupts.',
    select: anyOf(isNumberCard, isFace(['K', 'Q'])),
  },
  {
    id: 'wrecker',
    label: 'Wrecker',
    blurb:
      'Numbers 4-9 plus every Jack and Joker, no Kings or Queens. Disruption ' +
      'first — tear the opponent down rather than race them.',
    select: anyOf(inValueRange(4, 9), isFace(['J']), isJokerCard),
  },
  {
    id: 'kings-lowball',
    label: 'Kings & Lowballs',
    blurb:
      'Numbers A-5 plus Kings, Queens, and Jokers, no Jacks. Doubles small ' +
      'cards early for big jumps; Queens fix direction; no removal at all.',
    select: anyOf(inValueRange(1, 5), isFace(['K', 'Q']), isJokerCard),
  },
  {
    id: 'jack-control',
    label: 'Jack Control',
    blurb:
      'Numbers 5-10 plus every Jack and Joker, no Kings or Queens. A slower, ' +
      'midrange numeric game backed by heavy answers to the opponent\'s stacks.',
    select: anyOf(inValueRange(5, 10), isFace(['J']), isJokerCard),
  },
  {
    id: 'thin-and-mean',
    label: 'Thin & Mean',
    blurb:
      'Numbers 4-7 plus every face card and both Jokers — the smallest legal ' +
      'deck (30), a narrow numeric band traded for the full control toolkit.',
    select: anyOf(inValueRange(4, 7), ALL_FACES_AND_JOKERS),
  },
  {
    id: 'all-numbers',
    label: 'All Numbers, No Faces',
    blurb:
      'All 40 number cards, zero face cards or Jokers. A committed value ' +
      'racer with no offense or defense tools of its own.',
    select: isNumberCard,
  },
  {
    id: 'face-feast',
    label: 'Face Feast',
    blurb:
      'Numbers A-4 plus every face card and both Jokers — minimum viable ' +
      'numbers, maximum control toolkit.',
    select: anyOf(inValueRange(1, 4), ALL_FACES_AND_JOKERS),
  },

  // -- Queen-focused variants -------------------------------------------
  // Are Queens (direction-flip) worth their slot? These isolate the question
  // two ways: matched pairs that swap Queens in for Jacks at an identical
  // numeric curve (so the *only* difference is which face card is present),
  // and no-Queen / half-Queen cuts of decks that used to carry all four.
  {
    id: 'queen-control',
    label: 'Queen Control',
    blurb:
      'Numbers 5-10 plus every Queen and Joker, no Jacks or Kings — Jack ' +
      "Control's exact numeric curve with Queens standing in for Jacks.",
    select: anyOf(inValueRange(5, 10), isFace(['Q']), isJokerCard),
  },
  {
    id: 'queen-wrecker',
    label: 'Queen Wrecker',
    blurb:
      "Numbers 4-9 plus every Queen and Joker, no Jacks or Kings — Wrecker's " +
      'exact numeric curve with Queens standing in for Jacks.',
    select: anyOf(inValueRange(4, 9), isFace(['Q']), isJokerCard),
  },
  {
    id: 'high-roller-noq',
    label: 'High Roller, No Queens',
    blurb: 'High Roller with its four Queens cut — Jacks, Kings, and Jokers only.',
    select: anyOf(inValueRange(6, 10), isFace(['J', 'K']), isJokerCard),
  },
  {
    id: 'mid-curve-noq',
    label: 'Mid Curve, No Queens',
    blurb: 'Mid Curve with its four Queens cut — Jacks, Kings, and Jokers only.',
    select: anyOf(inValueRange(3, 8), isFace(['J', 'K']), isJokerCard),
  },
  {
    id: 'full-pool-noq',
    label: 'Full Pool, No Queens',
    blurb: 'Every card except the four Queens (50 of 54).',
    select: (card) => card.rank !== 'Q',
  },
  {
    id: 'pure-builder-noq',
    label: 'Pure Builder, No Queens (Kings Only)',
    blurb:
      'Pure Builder with its four Queens cut — all ten number ranks plus ' +
      'Kings only, no Jacks, Queens, or Jokers.',
    select: anyOf(isNumberCard, isFace(['K'])),
  },
  {
    id: 'full-pool-halfq',
    label: 'Full Pool, Half Queens',
    blurb: 'Every card except two of the four Queens (52 of 54).',
    select: (card) => card.rank !== 'Q' || card.suit === 'S' || card.suit === 'H',
  },
  {
    id: 'pure-builder-halfq',
    label: 'Pure Builder, Half Queens',
    blurb:
      'Pure Builder with two of its four Queens cut — all ten number ranks ' +
      'plus Kings and two Queens.',
    select: (card) =>
      isNumberCard(card) ||
      card.rank === 'K' ||
      (card.rank === 'Q' && (card.suit === 'S' || card.suit === 'H')),
  },
];

/** The card ids `strategy` keeps for `owner`, ready to hand to `createMatch`. */
export function draftDeck(strategy: DeckStrategy, owner: Seat): string[] {
  return buildPool(owner, 'build')
    .filter(strategy.select)
    .map((card) => card.id);
}

function strategyById(id: string): DeckStrategy {
  const found = DECK_STRATEGIES.find((s) => s.id === id);
  if (!found) throw new Error(`unknown strategy id: ${id}`);
  return found;
}

/**
 * Which named strategies each difficulty draws its table deck from, decided
 * by the round-robin tournaments in `deck-tournament.ts` rather than picked by
 * hand: these are the five strategies from the `hard` vs. `extreme` lookahead
 * comparison, each pool excluding the one that most exploited that
 * difficulty's blind spot — `high-roller` overwhelms `hard`'s two-ply search
 * before it can out-plan the curve, and `full-pool` was `extreme`'s worst
 * performer once it could actually see what a trimmed deck was missing.
 */
const HARD_BOT_STRATEGIES = ['jack-control', 'full-range-thin', 'full-pool', 'mid-curve-noq'];
const EXTREME_BOT_STRATEGIES = ['high-roller', 'jack-control', 'full-range-thin', 'mid-curve-noq'];

/**
 * The deck a bot brings to the table. `hard` and `extreme` draw a random
 * strategy from their own measured pool above; every other difficulty (and
 * every mode but `build`, which is the only pool those strategies were
 * drafted against) falls back to the mode's whole pool, same as before this
 * existed.
 *
 * Seeded off the room rather than `Math.random()`, so a rematch's fresh seed
 * picks independently but a given seed always picks the same strategy — the
 * same determinism-from-seed the rest of a match already has.
 */
export function pickBotDeck(
  difficulty: Difficulty | null,
  mode: DeckModeId,
  seed: string,
  owner: Seat,
): string[] {
  const ids =
    mode === 'build' && difficulty === 'hard'
      ? HARD_BOT_STRATEGIES
      : mode === 'build' && difficulty === 'extreme'
        ? EXTREME_BOT_STRATEGIES
        : null;
  if (!ids) return buildPool(owner, mode).map((card) => card.id);

  const rng = createRng(`${seed}:bot-deck`);
  const strategy = strategyById(ids[rng.nextInt(ids.length)]!);
  return draftDeck(strategy, owner);
}
