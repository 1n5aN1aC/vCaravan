/**
 * Table sound effects, picked up from `src/assets/sounds/` at build time —
 * bundled, content-hashed, and grouped into cues by the folder they sit in, the
 * same way card art is matched by filename (see `cardArt.ts`).
 *
 *   assets/sounds/addtotrack/*.mp3   a card landing on a caravan
 *   assets/sounds/removecard/*.mp3   a card forced off one — Jack or Joker
 *   assets/sounds/addremove/*.mp3    a card you chose to give up — discard or disband
 *   assets/sounds/addtodeck/*.mp3    a card selected or deselected while building a deck
 *   assets/sounds/startgame/*.mp3    the board arriving
 *   assets/sounds/win/*.mp3          the match decided, your way
 *   assets/sounds/lose/*.mp3         the match decided, theirs
 *
 * A cue holds however many takes the folder happens to have and picks between
 * them at random, so the same move does not sound identical twice running. A cue
 * with no files is silent, which means an empty folder changes nothing.
 */

import { createToggle } from './audioToggle.js';

const modules = import.meta.glob('./assets/sounds/**/*.{mp3,ogg,m4a,wav,webm,opus}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** The cues the game fires. A folder named anything else is ignored. */
export const CUES = [
  'addtotrack',
  'removecard',
  'addremove',
  'addtodeck',
  'startgame',
  'win',
  'lose',
] as const;
export type Cue = (typeof CUES)[number];

const takes = new Map<Cue, string[]>(CUES.map((cue) => [cue, []]));

for (const [path, url] of Object.entries(modules)) {
  const folder = path.split('/').at(-2)?.toLowerCase() as Cue | undefined;
  if (folder && takes.has(folder)) takes.get(folder)!.push(url);
}
// Globs come back in a stable order, but sort anyway so "which take played" is
// reproducible from the filename rather than from bundler internals.
for (const list of takes.values()) list.sort();

/** How loud cues play. Card sounds are punctuation, not the main event. */
const VOLUME = 0.55;

/**
 * The main sound switch, as a store `useSyncExternalStore` can read. Off means
 * silence: no cues, and the ambience loop and music in `music.ts` stop too
 * (they also have their own switches, which this sits over). The choice is
 * remembered, because a player who mutes the game means it.
 */
export const sound = {
  ...createToggle('caravan.sound'),
  /** True when any cue has at least one file behind it. */
  hasCues: (): boolean => [...takes.values()].some((list) => list.length > 0),
};

/**
 * The take played most recently for each cue, so the next pick can avoid it.
 * With two or more takes a cue therefore never repeats back to back — which is
 * the repetition an ear actually notices.
 */
const lastPlayed = new Map<Cue, string>();

const decoded = new Map<string, HTMLAudioElement>();

/** A preloaded element per file, so the first play is not the first fetch. */
function preload(url: string): HTMLAudioElement {
  let audio = decoded.get(url);
  if (!audio) {
    audio = new Audio(url);
    audio.preload = 'auto';
    audio.volume = VOLUME;
    decoded.set(url, audio);
  }
  return audio;
}

/**
 * Fires one cue. Never throws and never awaits: a browser that refuses to play
 * before the page has been interacted with, or a file that fails to decode, is
 * a silent card — not a broken board.
 */
export function playCue(cue: Cue): void {
  if (!sound.isEnabled()) return;
  const list = takes.get(cue);
  if (!list || list.length === 0) return;

  const previous = lastPlayed.get(cue);
  const pool = list.length > 1 ? list.filter((url) => url !== previous) : list;
  const url = pool[Math.floor(Math.random() * pool.length)]!;
  lastPlayed.set(cue, url);

  // Cloned so overlapping cues layer instead of cutting each other off — two
  // cards can leave the table on one move, and a move can both add and remove.
  const audio = preload(url).cloneNode() as HTMLAudioElement;
  audio.volume = VOLUME;
  try {
    // `play()` returns a promise in browsers and nothing at all under jsdom, so
    // the rejection handler has to be attached defensively.
    const started = audio.play() as Promise<void> | undefined;
    void started?.catch(() => {});
  } catch {
    // An environment with no audio output at all. Nothing to recover.
  }
}

/**
 * Warms the cache once, on the first play. Called from the board rather than at
 * import time so a spectator sitting on the landing page pays nothing for it.
 */
export function primeSounds(): void {
  if (!sound.isEnabled()) return;
  for (const list of takes.values()) for (const url of list) preload(url);
}

/**
 * Warms one cue ahead of the rest. The cue that most needs this is `startgame`:
 * it fires on the very first snapshot, in the same breath as `primeSounds` —
 * so without a head start it is the one cue guaranteed to be played cold. See
 * `preload.ts`, which is what gives it that head start.
 */
export function primeCue(cue: Cue): void {
  if (!sound.isEnabled()) return;
  for (const url of takes.get(cue) ?? []) preload(url);
}

if (import.meta.env.DEV) {
  const summary = CUES.map((cue) => `${cue} ${takes.get(cue)!.length}`).join(', ');
  console.info(`[sound] ${summary}`);
}
