/**
 * Sums the per-shard JSON standings `deck-tournament.ts --out=...` writes and
 * prints the combined table. `tsx src/combine-tournament.ts shard1.json shard2.json ...`
 */
import { readFileSync } from 'node:fs';
import { printTable, type Standing } from './deck-tournament.js';

const files = process.argv.slice(2);
if (files.length === 0) throw new Error('usage: combine-tournament.ts <shard.json>...');

// Built from whatever ids the shards actually carried, not the full roster in
// deck-strategies.ts — a follow-up tournament run with `--ids=` only ever
// produces shards for its own subset, and rows for strategies that weren't
// part of this run (0 games) would otherwise sort as NaN.
const standings = new Map<string, Standing>();

for (const file of files) {
  const shard: Record<string, Standing> = JSON.parse(readFileSync(file, 'utf8'));
  for (const [id, part] of Object.entries(shard)) {
    if (part.games === 0) continue;
    if (!standings.has(id)) standings.set(id, { wins: 0, losses: 0, draws: 0, games: 0 });
    const total = standings.get(id)!;
    total.wins += part.wins;
    total.losses += part.losses;
    total.draws += part.draws;
    total.games += part.games;
  }
}

printTable(standings);
