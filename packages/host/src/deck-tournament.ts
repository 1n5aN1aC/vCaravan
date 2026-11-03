/**
 * Round-robin tournament: every deck-building strategy in `deck-strategies.ts`
 * (or the subset named by `--ids=a,b,c`) against every other, played out by
 * the same bot difficulty on both sides — `--difficulty=hard` (default) or
 * `--difficulty=extreme` — so the only variable between games in a pairing is
 * which deck each side drafted.
 *
 * `pnpm --filter @caravan/server tournament -- --seeds=6`
 *
 * Each pairing plays `seeds` seeds, and each seed twice with the two decks
 * swapped between seats — canceling any seat-order asymmetry rather than
 * relying on the engine's coin-flip for who moves first to average it out on
 * its own. Strategy-vs-itself pairings are skipped: a mirror match speaks to
 * variance, not to which of two different strategies is better.
 *
 * The `hard` bot's two-ply search over sampled worlds costs real wall-clock —
 * tens of seconds a game — so a full round robin is sharded across processes
 * rather than run serially in one: `--shard=k --shards=n` restricts this
 * process to every nth pairing, and `--out=path` writes its partial standings
 * as JSON instead of a console table. `combine-tournament.ts` sums the shards
 * back into one result. Omit both and this runs the whole thing serially,
 * which is what you want for a small `--seeds` smoke test.
 */
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { Difficulty } from '@caravan/protocol';
import {
  applyMove,
  checkDeckSelection,
  createMatch,
  type MatchState,
  type Seat,
} from '@caravan/rules';
import { chooseMove, type OpponentModel } from './bot.js';
import { DECK_STRATEGIES, draftDeck, type DeckStrategy } from './deck-strategies.js';

const arg = (name: string, fallback: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.slice(name.length + 3)) : fallback;
};
const strArg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const SEEDS = arg('seeds', 6);
const SHARD = arg('shard', 0);
const SHARDS = arg('shards', 1);
const OUT = strArg('out');
const IDS = strArg('ids')?.split(',');
const DIFFICULTY = (strArg('difficulty') ?? 'hard') as Difficulty;
const MAX_PLIES_GUARD = 400;

/** All strategies, or just the ids named by `--ids=a,b,c` when given — lets a
 *  follow-up tournament restrict itself to a subset (e.g. an old top N plus a
 *  batch of new variants) without touching the full roster in
 *  `deck-strategies.ts`. */
const STRATEGIES: DeckStrategy[] = IDS
  ? IDS.map((id) => {
      const found = DECK_STRATEGIES.find((s) => s.id === id);
      if (!found) throw new Error(`unknown strategy id: ${id}`);
      return found;
    })
  : DECK_STRATEGIES;

// `hard` never gets to see the opponent's real built deck (that's `extreme`'s
// whole difference) — it only knows the table's deck mode, same as a human
// opponent would. `extreme` is handed the opponent's actual keep list, same as
// the hub would for a real table — see `assumedDeck` in bot.ts. Building the
// right one per mover (not a single shared constant) is what makes `extreme`
// actually extreme here instead of quietly playing as `hard` with a fancier name.
function tableFor(mover: Seat, deckA: string[], deckB: string[]): OpponentModel {
  if (DIFFICULTY !== 'extreme') return { mode: 'build' };
  return { mode: 'build', deck: mover === 0 ? deckB : deckA };
}

export interface Standing {
  wins: number;
  losses: number;
  draws: number;
  games: number;
}

function freshStanding(): Standing {
  return { wins: 0, losses: 0, draws: 0, games: 0 };
}

/** Plays one match to completion (or the guard) and returns the final state. */
function playMatch(seed: string, deckA: string[], deckB: string[]): MatchState {
  let state = createMatch(seed, [deckA, deckB]).state;
  for (let i = 0; i < MAX_PLIES_GUARD && state.phase !== 'over'; i++) {
    const table = tableFor(state.turn, deckA, deckB);
    const move = chooseMove(state, state.turn, DIFFICULTY, table);
    if (!move) break; // unreachable in practice — evaluateMatch ends the match first
    state = applyMove(state, state.turn, move).state;
  }
  return state;
}

/** Records one finished game's result against both sides' standings. */
function record(state: MatchState, seatStanding: [Standing, Standing]): void {
  const result = state.result;
  if (!result || result.kind === 'draw') {
    seatStanding[0].draws++;
    seatStanding[1].draws++;
  } else {
    seatStanding[result.seat].wins++;
    seatStanding[result.seat === 0 ? 1 : 0].losses++;
  }
  seatStanding[0].games++;
  seatStanding[1].games++;
}

function main(): void {
  for (const strategy of STRATEGIES) {
    for (const seat of [0, 1] as Seat[]) {
      const deck = draftDeck(strategy, seat);
      const reason = checkDeckSelection(seat, deck, 'build');
      if (reason) throw new Error(`${strategy.id} (seat ${seat}): ${reason}`);
    }
  }

  const standings = new Map<string, Standing>();
  for (const s of STRATEGIES) standings.set(s.id, freshStanding());

  const allPairs: Array<[DeckStrategy, DeckStrategy]> = [];
  for (let i = 0; i < STRATEGIES.length; i++) {
    for (let j = i + 1; j < STRATEGIES.length; j++) {
      allPairs.push([STRATEGIES[i]!, STRATEGIES[j]!]);
    }
  }
  const pairs = allPairs.filter((_, i) => i % SHARDS === SHARD);

  const start = Date.now();
  let played = 0;
  const totalGames = pairs.length * SEEDS * 2;
  console.log(
    `shard ${SHARD}/${SHARDS}: ${pairs.length} pairings, ${totalGames} games, seeds=${SEEDS}, difficulty=${DIFFICULTY}`,
  );

  for (const [strA, strB] of pairs) {
    const standA = standings.get(strA.id)!;
    const standB = standings.get(strB.id)!;
    for (let s = 0; s < SEEDS; s++) {
      const seedBase = `tourney:${DIFFICULTY}:${strA.id}:${strB.id}:${s}`;

      // A sits seat 0, B sits seat 1.
      {
        const deckA = draftDeck(strA, 0);
        const deckB = draftDeck(strB, 1);
        const state = playMatch(`${seedBase}:a0`, deckA, deckB);
        record(state, [standA, standB]);
        played++;
      }
      // Swapped: B sits seat 0, A sits seat 1.
      {
        const deckB = draftDeck(strB, 0);
        const deckA = draftDeck(strA, 1);
        const state = playMatch(`${seedBase}:b0`, deckB, deckA);
        record(state, [standB, standA]);
        played++;
      }
    }
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);
    console.log(
      `[shard ${SHARD}] [${played}/${totalGames}] ${strA.label} vs ${strB.label} done (${elapsed}s elapsed)`,
    );
  }

  if (OUT) {
    const payload = Object.fromEntries(standings);
    writeFileSync(OUT, JSON.stringify(payload, null, 2));
    console.log(`shard ${SHARD}: wrote ${OUT}`);
    return;
  }

  printTable(standings);
  console.log(`\nTotal: ${played} games in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

export function printTable(standings: Map<string, Standing>): void {
  const byId = new Map(DECK_STRATEGIES.map((s) => [s.id, s]));
  const rows = [...standings.entries()]
    .map(([id, standing]) => {
      const strategy = byId.get(id);
      if (!strategy) throw new Error(`unknown strategy id: ${id}`);
      return { strategy, ...standing };
    })
    .sort((a, b) => b.wins / b.games - a.wins / a.games);

  console.log('\n=== Final standings ===');
  console.log(
    `${'#'.padStart(2)}  ${'Strategy'.padEnd(24)} ${'W'.padStart(4)} ${'L'.padStart(4)} ${'D'.padStart(4)} ${'Games'.padStart(6)}  Win%`,
  );
  rows.forEach((row, i) => {
    const pct = ((row.wins / row.games) * 100).toFixed(1);
    console.log(
      `${String(i + 1).padStart(2)}  ${row.strategy.label.padEnd(24)} ${String(row.wins).padStart(4)} ${String(row.losses).padStart(4)} ${String(row.draws).padStart(4)} ${String(row.games).padStart(6)}  ${pct}%`,
    );
  });

  console.log('\n=== Top 4 ===');
  rows.slice(0, 4).forEach((row, i) => {
    console.log(`${i + 1}. ${row.strategy.label} — ${row.strategy.blurb}`);
  });
}

// Guarded so `combine-tournament.ts` can import `printTable`/`Standing` without
// kicking off a full tournament run as an import side effect.
const isEntryPoint = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) main();
