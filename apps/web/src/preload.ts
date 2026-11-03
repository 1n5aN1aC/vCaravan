/**
 * Fetching things before they are wanted.
 *
 * Everything here is already bundled and content-hashed, so any static host
 * worth using lets it be cached for good, and a warmed file stays warm across
 * reloads and matches. All this module decides is *when* to ask for each one.
 *
 * Two tiers, because the point is a head start rather than a stampede:
 *
 *   now   — the small, certain things: card backs, the deal, the room tone.
 *           Wanted within seconds of the page appearing.
 *   idle  — the bulk: 52 faces and the remaining cues. Wanted eventually,
 *           and worth nothing if it delays the board arriving.
 *
 * Each asset is warmed through the same kind of object that will later use it —
 * an `Image` for art, an `Audio` for sound — rather than through `fetch`. That
 * costs nothing extra (the second use is a cache hit, and for cues `sound.ts`
 * literally reuses the element) and it avoids betting on how a browser reconciles
 * a cached whole-file response with the range requests a media element makes.
 *
 * Deliberately *not* warmed: the music. It is nineteen megabytes across nine
 * tracks, only one of which will be heard first, and it streams perfectly well
 * on demand — precaching it would spend the entire bandwidth budget on the one
 * thing that least needs it. The room tone is the exception because it is a
 * single file that starts the instant the audio gate opens.
 */

import { artUrls } from './cardArt.js';
import { primeAmbience } from './music.js';
import { primeCue, primeSounds } from './sound.js';

/**
 * How many warm-up fetches are allowed to be outstanding. The browser will
 * happily open six connections for these and leave nothing for the socket, the
 * board's own images, or the track that is actually playing.
 */
const CONCURRENCY = 3;

const queue: string[] = [];
let active = 0;
let warmed = new Set<string>();

/** Queues an image, unless it has already been asked for. */
function enqueue(url: string): void {
  if (warmed.has(url)) return;
  warmed.add(url);
  queue.push(url);
  pump();
}

function pump(): void {
  while (active < CONCURRENCY && queue.length > 0) {
    const url = queue.shift()!;
    active += 1;
    const image = new Image();
    // A warm-up must never take priority over anything on screen.
    image.decoding = 'async';
    if ('fetchPriority' in image) image.fetchPriority = 'low';
    const done = () => {
      active -= 1;
      pump();
    };
    // `error` counts as done: a missing or corrupt file must not wedge the
    // queue behind it. It will simply be drawn as the CSS face instead.
    image.addEventListener('load', done, { once: true });
    image.addEventListener('error', done, { once: true });
    image.src = url;
  }
}

/** `requestIdleCallback` where it exists, a short timer where it does not. */
function whenIdle(work: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => work(), { timeout: 3000 });
  else setTimeout(work, 500);
}

let started = false;

/**
 * Warms the assets a session is going to want. Safe to call more than once —
 * the second call does nothing — and safe to call on a machine with none of
 * these assets bundled, where every list below is simply empty.
 *
 * Called from the app shell rather than from the board, because the whole point
 * is to be early: by the time a board exists, the deal has already been dealt.
 */
export function warmAssets(): void {
  if (started) return;
  started = true;

  // Now: the backs are on screen almost immediately, the deal is the first
  // sound anyone hears, and the room tone is wanted at the first click.
  for (const url of artUrls.backs) enqueue(url);
  primeCue('startgame');
  primeAmbience();

  // Idle: everything else. The faces go first because a missing face is
  // visible, where a cold cue is only slightly late.
  whenIdle(() => {
    for (const url of artUrls.faces) enqueue(url);
    primeSounds();
  });
}

/** Test seam: forgets what has been warmed so a case can start from cold. */
export function resetWarmAssets(): void {
  started = false;
  warmed = new Set();
  queue.length = 0;
  active = 0;
}
