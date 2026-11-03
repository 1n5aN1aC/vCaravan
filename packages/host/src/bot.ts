import type { Difficulty } from '@caravan/protocol';
import {
  DEFAULT_DECK_MODE,
  RULES,
  applyMove,
  buildPool,
  fullPool,
  caravanStatus,
  caravanValue,
  cardValue,
  createRng,
  isNumberCard,
  isOverburdened,
  listLegalMoves,
  resolveTracks,
  shuffle,
  type Caravan,
  type Card,
  type CaravanStatus,
  type DeckModeId,
  type MatchState,
  type Move,
  type Rng,
  type Seat,
} from '@caravan/rules';

/**
 * The AI opponent. Four difficulties. The first three are tiers of how much
 * effort goes into a move, not a knob on the same algorithm; the fourth is the
 * third told something it is not otherwise allowed to know:
 *
 * - `easy`    one ply, no search: scores its own board and ignores the
 *             opponent entirely.
 * - `medium`  the same one-ply scorer with the opponent's board counted
 *             against it, which is what turns Jacks, Queens and Kings into
 *             weapons.
 * - `hard`    a fixed, lane-aware evaluation function (below), searched two
 *             plies deep — its move, then the opponent's best reply — with the
 *             opponent's hidden hand sampled rather than known. It knows only
 *             what a player in that seat knows: the table's deck mode, from
 *             which it assumes an untrimmed pool.
 * - `extreme` the same search, told which cards the opponent's built deck
 *             actually kept. Nothing else differs — same evaluation, same
 *             depth, same number of samples — so the difference between the
 *             two *is* that knowledge and nothing else.
 *
 * Neither of the searching two ever reads the opponent's hand or either deck's
 * real draw order, even though both are sitting right there in `MatchState`.
 * See `OpponentModel`.
 *
 * All four choose only from `listLegalMoves`, which is what makes them
 * incapable of an illegal move — the hub re-validates anyway, but the bot can
 * never be the thing that fails.
 */

/**
 * What a caravan past the sell cap is worth to its owner. Flat: how *far* past
 * the cap it is says nothing about what either player can do about it, since
 * the ways back — a disband, or a Jack — are available at 27 and at 40 alike.
 * Pricing the excess is what used to make piling more onto a dead caravan look
 * like progress, and it is the same number from both sides of the table: it is
 * why the bot would spend a King on an opponent caravan already over the cap,
 * doubling a card that was itself already doubled, for a "gain" that changed
 * nothing about the game. Shared by both scorers, which had the flaw alike.
 */
const OVERBURDENED = -50;

/**
 * What spending a card costs, in the same currency as the position scores.
 * Deliberately smaller than any real difference between positions, so it only
 * ever decides between moves the evaluation genuinely cannot tell apart.
 *
 * Without it, a move that changes nothing scores exactly as well as the best
 * move available when nothing is available — the bot has no notion that a card
 * played is a card gone, so burning a Jack on a caravan already past saving is
 * free. With it, the cheapest way to change nothing is to pitch the least
 * useful card in hand, which is what a player would actually do.
 */
function spendCost(card: Card | undefined): number {
  if (!card) return 0; // a disband spends nothing
  switch (card.rank) {
    case 'JOKER':
    case 'J':
      return 0.9;
    case 'K':
      return 0.7;
    case 'Q':
      return 0.5;
    default:
      return 0.2;
  }
}

/** The card a move spends, if it spends one. */
function movedCard(state: MatchState, seat: Seat, move: Move): Card | undefined {
  if (move.type === 'disband') return undefined;
  return state.players[seat].hand.find((c) => c.id === move.cardId);
}

/** Score for one caravan's value, from the owner's point of view. Used by
 *  `easy` and `medium`'s one-ply scorer. */
function bandScore(value: number): number {
  if (value === 0) return 0;
  // In the sell range: the whole point of the game. Higher inside the band beats
  // lower, since ties leave the track undecided and the higher one wins outright.
  if (value >= RULES.SELL_MIN && value <= RULES.SELL_MAX) return 100 + value;
  // Over the range: cannot sell. Flat, deliberately — see `laneScore`.
  if (value > RULES.SELL_MAX) return OVERBURDENED;
  // Under: progress toward the band is worth exactly how far it got.
  return value;
}

/** How well a seat's three caravans are doing, ignoring the opponent. */
function boardScore(state: MatchState, seat: Seat): number {
  return state.players[seat].caravans.reduce((sum, c) => sum + bandScore(caravanValue(c)), 0);
}

/**
 * The position from the bot's point of view, for `easy`/`medium` only.
 * `easy` weighs only its own board — it is not trying to hurt anybody.
 * `medium` subtracts the opponent's, and that one sign flip is the whole of
 * its offense: destroying a 24 with a Jack, or Kinging an opponent's 13 into
 * an unsellable 26+, both fall straight out of it. So does the restraint —
 * Kinging an opponent's 12 into a tidy 24 scores as the gift it is.
 */
function positionScore(state: MatchState, seat: Seat, difficulty: Difficulty): number {
  const mine = boardScore(state, seat);
  if (difficulty !== 'medium') return mine;
  return mine - boardScore(state, seat === 0 ? 1 : 0);
}

/** A caravan the bot would rather be rid of than keep. */
function worthDisbanding(state: MatchState, seat: Seat, caravan: number): boolean {
  const target = state.players[seat].caravans[caravan];
  return target !== undefined && isOverburdened(target);
}

/**
 * Disbanding throws away a whole caravan, which is almost never what a
 * reasonable choice should land on. So every difficulty drops disbands unless
 * the caravan is already unsellable.
 */
function candidates(state: MatchState, seat: Seat, difficulty: Difficulty): Move[] {
  return listLegalMoves(state, seat).filter((move) => {
    if (move.type === 'disband') return worthDisbanding(state, seat, move.caravan);
    // `easy` keeps its hands off the other side of the table entirely, which is
    // what stops it using face cards offensively.
    if (move.type === 'play' && difficulty === 'easy') return move.target.seat === seat;
    return true;
  });
}

/** The card ids that have somewhere useful to go this turn. */
function playableIds(moves: Move[]): Set<string> {
  const ids = new Set<string>();
  for (const move of moves) if (move.type === 'play') ids.add(move.cardId);
  return ids;
}

/** The opening round places three number cards on three empty caravans, and
 *  every one of them is legal. Start low: a caravan begun on a 10 has far
 *  less room to climb into the band than one begun on an Ace. Shared by every
 *  difficulty — there is no opponent reply worth searching for yet, and no
 *  board state for a lane-aware evaluation to read. */
function openingScore(state: MatchState, seat: Seat, move: Move): number {
  if (move.type !== 'play') return -Infinity; // unreachable: opening allows only plays
  const card = state.players[seat].hand.find((c) => c.id === move.cardId);
  return card && isNumberCard(card) ? -cardValue(card) : -100;
}

function scoreMove(
  state: MatchState,
  seat: Seat,
  move: Move,
  difficulty: Difficulty,
  playable: Set<string>,
): number {
  // Passing up the turn: it changes nothing about the board and costs the card,
  // so it is priced as exactly that. Any play that improves the position beats
  // it, any play that hurts does not, and a play that does neither is chosen
  // over it only if it spends something cheaper — which no play ever does.
  if (move.type === 'discard') {
    const card = movedCard(state, seat, move);
    // Prefer to pitch something that had nowhere to go anyway.
    return -spendCost(card) - (playable.has(move.cardId) ? 0.5 : 0);
  }

  if (state.phase === 'opening') return openingScore(state, seat, move);

  let after: MatchState;
  try {
    after = applyMove(state, seat, move).state;
  } catch {
    // Unreachable — every candidate came from `listLegalMoves`.
    return -Infinity;
  }

  const delta =
    positionScore(after, seat, difficulty) -
    positionScore(state, seat, difficulty) -
    spendCost(movedCard(state, seat, move));
  // Losing a caravan to get out of an overburdened one is a real cost even when
  // the arithmetic likes it, so it has to clear a small bar first.
  return move.type === 'disband' ? delta - 20 : delta;
}

/** Uniform pick, seeded. */
function pick<T>(items: T[], rng: Rng): T | null {
  if (items.length === 0) return null;
  return items[rng.nextInt(items.length)]!;
}

/** Best-scored move(s) by `scoreMove`, tie broken by `rng`. Shared by `easy`
 *  and `medium`, which differ only in what `scoreMove` does with `difficulty`. */
function chooseByOnePly(
  state: MatchState,
  seat: Seat,
  difficulty: Difficulty,
  moves: Move[],
  rng: Rng,
): Move | null {
  const playable = playableIds(moves);
  let best = -Infinity;
  let tied: Move[] = [];
  for (const move of moves) {
    const score = scoreMove(state, seat, move, difficulty, playable);
    if (score > best) {
      best = score;
      tied = [move];
    } else if (score === best) {
      tied.push(move);
    }
  }
  return pick(tied, rng);
}

// -- hard: fixed evaluation + two-ply search over a sampled opponent hand ---

/**
 * How one caravan's status (from `caravanStatus`, which already compares it
 * against the caravan facing it) counts toward the fixed evaluation. This is
 * what `easy`/`medium`'s plain `bandScore` misses: being in the 21-26 band
 * only matters if it also beats the opposing lane, so the score is keyed off
 * the actual resolution the engine would apply, not off value alone.
 */
/**
 * The most one Jack could take off this caravan: the largest contribution any
 * single slot makes, its Kings included. A 24 standing on a King-doubled 10 has
 * 20 of itself in one slot and dies to a single card; a 24 spread over five
 * cards loses at most a few and is still building afterwards. `caravanValue`
 * rates the two identically, which is why this is measured separately.
 */
function biggestSlotLoss(caravan: Caravan): number {
  let worst = 0;
  for (const slot of caravan.slots) {
    const kings = slot.attached.filter((c) => c.rank === 'K').length;
    worst = Math.max(worst, cardValue(slot.card) * 2 ** kings);
  }
  return worst;
}

/**
 * What that exposure is worth against a lane's own score. Well under the gap
 * between a sold lane and a tied one, so robustness breaks ties between lanes
 * of the same standing rather than deciding which standing is preferable.
 */
const FRAGILITY = 0.5;

/**
 * How one caravan's status (from `caravanStatus`, which already compares it
 * against the caravan facing it) counts toward the fixed evaluation. This is
 * what `easy`/`medium`'s plain `bandScore` misses: being in the 21-26 band
 * only matters if it also beats the opposing lane, so the score is keyed off
 * the actual resolution the engine would apply, not off value alone.
 *
 * A lane that is in the band has something to lose, so it is also priced by how
 * survivable it is. This cuts both ways by construction, since `evaluate`
 * subtracts the opponent's lanes: it makes the bot prefer building sales that
 * cannot be undone by one Jack, and prefer attacking the opponent's sales that
 * can. A lane still building is not discounted — there is no sale to lose yet.
 *
 * Reasoned, not measured: against the same bot without this term or `MAJORITY`,
 * over 128 paired matches, 69-59 — which is not a difference. Bot against bot
 * may simply not produce the positions it decides, since both sides build alike
 * and neither is holding a Jack back for the brittle caravan opposite. Kept
 * because the claim stands on the rules, not because the games showed it.
 */
function laneScore(status: CaravanStatus, caravan: Caravan): number {
  const value = caravanValue(caravan);
  switch (status) {
    case 'sold':
      return 150 + value - FRAGILITY * biggestSlotLoss(caravan); // winning this lane outright
    case 'tied':
      return 100 + value - FRAGILITY * biggestSlotLoss(caravan); // in range, undecided, still live
    case 'outbid':
      return 40 + value / 2; // in range but currently behind
    case 'overburdened':
      return OVERBURDENED;
    case 'building':
      return value;
  }
}

function laneTotal(state: MatchState, seat: Seat): number {
  let total = 0;
  for (let i = 0; i < state.players[seat].caravans.length; i++) {
    const caravan = state.players[seat].caravans[i]!;
    total += laneScore(caravanStatus(state, seat, i as 0 | 1 | 2), caravan);
  }
  return total;
}

/**
 * Holding two of the three tracks is not twice as good as holding one — it is
 * the game. Whoever holds two when the third resolves has won, whatever the
 * third does, so the second track is worth far more than the first and the
 * third is worth almost nothing on top.
 *
 * A per-lane sum cannot say that: three lanes added up are linear in how many
 * are sold, so a search that only ever sees `laneTotal` will trade the second
 * track for a bigger caravan elsewhere. This is the same blindness the
 * `state.result` check below covers for the one case where it is fatal; the
 * bonus is the gradient leading up to it.
 *
 * Reasoned, not measured — the same 69-59 as `FRAGILITY`, which the two were
 * added and benchmarked together in.
 */
const MAJORITY = 300;

function decidedTracks(state: MatchState, seat: Seat): number {
  return resolveTracks(state).filter((t) => t.decided && t.winner === seat).length;
}

function majorityBonus(state: MatchState, seat: Seat): number {
  const opponent: Seat = seat === 0 ? 1 : 0;
  const held = decidedTracks(state, seat) >= 2 ? MAJORITY : 0;
  const conceded = decidedTracks(state, opponent) >= 2 ? MAJORITY : 0;
  return held - conceded;
}

/**
 * Comfortably outside anything `laneTotal` can produce (three lanes, each
 * capped around 150 + a value in the 20s), so a decided result always
 * dominates the lane heuristic instead of merely nudging it.
 */
const WIN_SCORE = 100_000;

/**
 * The fixed evaluation function `hard` searches with: its own lanes minus
 * the opponent's, each lane scored by how it actually stands to resolve —
 * unless the match is actually over, in which case none of that matters.
 *
 * The match ends only when *all three* tracks are decided at once, which
 * means finishing your own last caravan while the other two already belong
 * to the opponent doesn't cash in a lane — it hands them the match, since
 * that was the only track still keeping the game alive. A per-lane sum can't
 * see that: it just prices the newly-sold lane at its usual bonus, the same
 * as it would with the other two still undecided. Checking `state.result`
 * first is what stops the search from ever treating "win the third lane,
 * losing 1-2" as an improvement over not finishing it.
 *
 * Exported for the tests that hold its terms to what they claim; the search is
 * the only caller. Testing them through `chooseMove` instead would prove very
 * little — a term worth a point or two is swamped by two plies of search over
 * eight sampled worlds, which is exactly why they are worth stating separately.
 */
export function evaluate(state: MatchState, seat: Seat): number {
  if (state.result) {
    if (state.result.kind === 'draw') return 0;
    return state.result.seat === seat ? WIN_SCORE : -WIN_SCORE;
  }
  const opponent: Seat = seat === 0 ? 1 : 0;
  return laneTotal(state, seat) - laneTotal(state, opponent) + majorityBonus(state, seat);
}

/**
 * What the bot is told about the table it is playing at. `mode` is public —
 * both seats chose it and the `room` frame carries it — so a bot may always
 * read it. `deck` is the card ids the opponent's built deck kept, which is
 * private: the protocol tells a seat only `decksReady`, never the cards. Only
 * `extreme` is allowed to look at it; see `assumedDeck`.
 */
export interface OpponentModel {
  mode: DeckModeId;
  deck?: readonly string[];
}

/**
 * The deck the bot proceeds as if the opponent built — the one line where the
 * two searching difficulties differ.
 *
 * `extreme` is handed what they actually kept. `hard` is not, and assumes the
 * whole of the table's pool: the deck a player who trimmed nothing would bring,
 * which is exactly what someone sitting across the table can infer from the
 * mode alone. That assumption is wrong about the cards a trimmed deck no longer
 * holds, and being wrong about them is the point — it is what `extreme` is
 * paying for.
 */
function assumedDeck(owner: Seat, difficulty: Difficulty, table?: OpponentModel): string[] {
  if (difficulty === 'extreme' && table?.deck) return [...table.deck];
  return buildPool(owner, table?.mode ?? DEFAULT_DECK_MODE).map((card) => card.id);
}

/**
 * The cards of `owner`'s deck that are not already visible on the table or in
 * their discard pile — the pool the opponent model deals a plausible hand from.
 * Blind to which of those cards are in `owner`'s hand versus still in their
 * deck, and to the deck's order: only the *count* of hidden cards (their hand
 * size) and which specific cards could be among them is used.
 *
 * `deck` is what the bot believes that deck to be, not what it is — see
 * `assumedDeck`. Resolving it against `fullPool` rather than the mode's pool is
 * deliberate: ids are self-describing, so a belief and a fact are read the
 * same way here.
 */
function hiddenPool(state: MatchState, owner: Seat, deck: readonly string[]): Card[] {
  const visible = new Set<string>();
  for (const caravan of state.players[owner].caravans) {
    for (const slot of caravan.slots) {
      visible.add(slot.card.id);
      for (const attached of slot.attached) visible.add(attached.id);
    }
  }
  for (const card of state.players[owner].discard) visible.add(card.id);

  const kept = new Set(deck);
  return fullPool(owner).filter((card) => kept.has(card.id) && !visible.has(card.id));
}

/**
 * One plausible world: a hand `owner` could be holding, and a deck to draw
 * into. The deck's order is fictional and is never read this deep, since the
 * search stops one reply short of anyone drawing from it — it exists only so
 * `applyMove` has something there.
 */
interface World {
  hand: Card[];
  deck: Card[];
}

/**
 * The worlds every candidate move is judged against — sampled once, from the
 * position *before* the move, and reused for all of them.
 *
 * Sharing them is what makes the candidates comparable. Sampling per candidate
 * meant each was averaged over a different set of imagined hands, so two moves
 * a point or two apart were ranked by whose sample happened to be kinder — the
 * bot's choice moved with the noise rather than with the position.
 *
 * The pre-move position is the right one to sample from: what the opponent
 * could be holding is their deck minus what is publicly theirs, and a move of
 * the bot's never changes that. Even a Jack only moves an opponent's card from
 * the table to their discard, and both are already public.
 */
function sampleWorlds(
  state: MatchState,
  owner: Seat,
  rng: Rng,
  count: number,
  deck: readonly string[],
): World[] {
  const pool = hiddenPool(state, owner, deck);
  const handSize = state.players[owner].hand.length;
  return Array.from({ length: count }, () => {
    const dealt = shuffle([...pool], rng);
    return { hand: dealt.slice(0, handSize), deck: dealt.slice(handSize) };
  });
}

/** `state` with `owner`'s hidden cards replaced by one sampled world. Everything
 *  already public — both boards, both discards, the bot's own hand — is left
 *  exactly as it is. */
function determinize(state: MatchState, owner: Seat, world: World): MatchState {
  const out = structuredClone(state);
  out.players[owner].hand = structuredClone(world.hand);
  out.players[owner].deck = structuredClone(world.deck);
  return out;
}

/**
 * The opponent's best immediate reply in a sampled world, judged by the same
 * fixed evaluation from their point of view — the reply a candidate move has
 * to survive.
 *
 * Scored the same way the bot scores its own moves, `spendCost` included. That
 * is not a detail: without it the modelled opponent is a *worse* player than
 * the bot itself, free to burn a Jack on a caravan already past saving for a
 * position that scores the same. Every candidate is then judged against a reply
 * softer than the one actually coming, which flatters moves that only look safe
 * because the imagined opponent wasted its turn.
 *
 * Exported for the test that holds it to that standard; nothing else calls it.
 */
export function bestReply(state: MatchState, seat: Seat): Move | null {
  let best: Move | null = null;
  let bestScore = -Infinity;
  for (const move of listLegalMoves(state, seat)) {
    let after: MatchState;
    try {
      after = applyMove(state, seat, move).state;
    } catch {
      continue; // unreachable — every move came from listLegalMoves
    }
    const score = evaluate(after, seat) - spendCost(movedCard(state, seat, move));
    if (score > bestScore) {
      bestScore = score;
      best = move;
    }
  }
  return best;
}

const HARD_SAMPLES = 8;

/**
 * A candidate move's score: apply it, then average over the shared sampled
 * worlds what the opponent's best reply does to the position. Averaging
 * across determinizations (rather than committing to one guessed hand) is
 * what keeps this from confidently playing a move that only works against
 * one specific hand the opponent probably doesn't hold.
 *
 * The plain mean, deliberately. Weighting the worse half was tried — the
 * reasoning being that the sampled worlds come from an assumed deck that is
 * wrong for any trimmed one, so their average is off-centre and a move should
 * have to hold up across them. Measured against a fixed opponent over identical
 * paired matches, it cost games, and monotonically: at weights of 0, 0.25, 0.5
 * and 0.75 the same bot won 17, 16, 14 and 11 of 24. The sampling error looks
 * to be a shifted mean rather than a bad tail, and shading every candidate
 * toward its worse half mostly penalises aggression that was correct.
 *
 * `plies` is how deep that goes. At 2 the candidate is judged by the position
 * the opponent's reply leaves — a position the bot never gets to improve, which
 * makes it pessimistic about anything that invites a strong-looking answer it
 * could actually punish. At 3 it plays its own best follow-up in that same
 * sampled world first, so a move is judged by where the exchange settles rather
 * than by the middle of it. Only the reply that was actually chosen is expanded
 * — greedy at every level — so the third ply roughly doubles the work instead
 * of squaring it.
 */
function hardScore(
  state: MatchState,
  seat: Seat,
  move: Move,
  worlds: World[],
  plies: number,
): number {
  let after: MatchState;
  try {
    after = applyMove(state, seat, move).state;
  } catch {
    return -Infinity; // unreachable — every candidate came from listLegalMoves
  }

  // The card is gone whatever the search says about the position it leaves, so
  // the cost is charged once here rather than inside `evaluate` — which is a
  // statement about a board, and knows nothing about how it was reached.
  const cost = spendCost(movedCard(state, seat, move));

  const opponent: Seat = seat === 0 ? 1 : 0;
  if (after.phase === 'over' || after.turn !== opponent) return evaluate(after, seat) - cost;

  let total = 0;
  for (const world of worlds) {
    const sampled = determinize(after, opponent, world);
    const reply = bestReply(sampled, opponent);
    let final = reply ? applyMove(sampled, opponent, reply).state : sampled;

    // The third ply: the bot's own answer to that reply, in the same world. The
    // opponent's hand there is still the sampled one, but the bot's is real, so
    // this is a follow-up it could actually make.
    if (plies >= 3 && !final.result && final.turn === seat) {
      const followUp = bestReply(final, seat);
      if (followUp) final = applyMove(final, seat, followUp).state;
    }

    total += evaluate(final, seat);
  }
  return total / worlds.length - cost;
}

/**
 * How deep each searching difficulty looks. `extreme` gets the third ply as
 * well as the deck knowledge, because on its own that knowledge measured as
 * worth nothing: it reaches the search only through the sampled hand, and at
 * two plies that hand decides exactly one greedy reply, which is far too small
 * a lever to spend it on. The extra ply is what gives it something to act on.
 *
 * Measured, unlike most of what is tuned in this file: `extreme` beat `hard`
 * 35-13 over 48 paired matches, and the two-ply `extreme` it replaced 40-8.
 * Depth is the lever here, which is worth knowing before reaching for a
 * cleverer evaluation.
 */
const PLIES: Partial<Record<Difficulty, number>> = { hard: 2, extreme: 3 };

/** The search `hard` and `extreme` share. They differ in `assumedDeck` and in
 *  how many plies of it they get. */
function chooseSearchedMove(
  state: MatchState,
  seat: Seat,
  difficulty: Difficulty,
  moves: Move[],
  rng: Rng,
  table?: OpponentModel,
): Move | null {
  // The opening round has no opponent reply worth searching for and no board
  // for the lane-aware evaluation to read yet, so it reuses the quick heuristic.
  if (state.phase === 'opening') return chooseByOnePly(state, seat, difficulty, moves, rng);

  const opponent: Seat = seat === 0 ? 1 : 0;
  const deck = assumedDeck(opponent, difficulty, table);
  const worlds = sampleWorlds(state, opponent, rng, HARD_SAMPLES, deck);

  let best = -Infinity;
  let tied: Move[] = [];
  for (const move of moves) {
    const score = hardScore(state, seat, move, worlds, PLIES[difficulty] ?? 2);
    if (score > best) {
      best = score;
      tied = [move];
    } else if (score === best) {
      tied.push(move);
    }
  }
  return pick(tied, rng);
}

/**
 * The bot's move, or null when it has none — which the engine makes unreachable,
 * since `evaluateMatch` ends the match the moment the seat to move is out of
 * legal moves. Pure and seeded: same state, same difficulty, same choice, so a
 * match against the AI replays from its seed exactly like any other.
 *
 * `table` is everything the caller knows about the table, handed over whole:
 * which difficulty may act on which part of it is decided here rather than at
 * the call site, so the hub cannot leak private knowledge into a difficulty
 * that is supposed to be without it. Today that means `extreme` reads the
 * opponent's built deck and nothing else does — a deliberate asymmetry, since
 * deck composition is private and a human opponent could not know it. Even
 * `extreme` never sees the opponent's *hand* or the order of either deck.
 */
export function chooseMove(
  state: MatchState,
  seat: Seat,
  difficulty: Difficulty,
  table?: OpponentModel,
): Move | null {
  const rng = createRng(`${state.seed}:bot`, state.ply);
  const moves = candidates(state, seat, difficulty);
  if (moves.length === 0) {
    // Only reachable if every legal move was a disband worth avoiding — in which
    // case avoiding it is no longer an option.
    return pick(listLegalMoves(state, seat), rng);
  }
  if (difficulty === 'hard' || difficulty === 'extreme') {
    return chooseSearchedMove(state, seat, difficulty, moves, rng, table);
  }
  return chooseByOnePly(state, seat, difficulty, moves, rng);
}
