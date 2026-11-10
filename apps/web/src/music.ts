/**
 * The two sounds that are *always* there rather than fired by a move: the room
 * tone and the radio. Both are picked up from `src/assets/` at build time the
 * same way card cues are (see `sound.ts`), and both are silent no-ops when the
 * folder behind them is empty.
 *
 *   assets/ambience/*   one file, looped forever under everything
 *   assets/music/*      a playlist; a random track, then a random *different* one
 *
 * Each has its own remembered mute. Over all of them sits the main sound
 * switch (`sound` in `sound.ts`): while that is off, neither plays, and turning
 * it back on brings back whichever of them were on before.
 *
 * Neither can start on its own. Browsers refuse audio until the page has been
 * interacted with, so the first click or keypress anywhere is what actually
 * begins playback; until then both sit armed and silent.
 */
import { createToggle } from './audioToggle.js';
import { sound } from './sound.js';

// Vite parses these at build time, so the options have to be inline literals.
const ambienceFiles = import.meta.glob('./assets/ambience/*.{opus,mp3,ogg,m4a,wav,webm}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
const musicFiles = import.meta.glob('./assets/music/*.{opus,mp3,ogg,m4a,wav,webm}', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** A track keeps its source filename, because that is the only readable name it has. */
export type Track = { title: string; url: string };

function toTracks(files: Record<string, string>): Track[] {
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, url]) => ({ title: prettify(path), url }));
}

/** `./assets/music/MUS_Blue_Moon.opus` → `Blue Moon`. */
function prettify(path: string): string {
  return (path.split('/').at(-1) ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/^MUS[_-]/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
}

const tracks = toTracks(musicFiles);
const ambienceTrack = toTracks(ambienceFiles)[0];

/** Both sit under the card cues, which are the thing the player is meant to hear. */
const AMBIENCE_VOLUME = 0.35;
const MUSIC_VOLUME = 0.22;

// ---------------------------------------------------------------------------
// Ambience — one file, looping.

let ambienceAudio: HTMLAudioElement | undefined;

export const ambience = {
  ...createToggle('caravan.ambience', () => syncAmbience()),
  available: (): boolean => ambienceTrack !== undefined,
};

/**
 * Builds the element without playing it. Split out so the file can be fetched
 * before the gesture that is allowed to start it — the room tone is two
 * megabytes and is wanted the instant the gate opens, which is far too late to
 * begin asking for it.
 */
function ensureAmbience(): HTMLAudioElement | undefined {
  if (!ambienceTrack) return undefined;
  if (!ambienceAudio) {
    ambienceAudio = new Audio(ambienceTrack.url);
    ambienceAudio.loop = true;
    ambienceAudio.volume = AMBIENCE_VOLUME;
    ambienceAudio.preload = 'auto';
  }
  return ambienceAudio;
}

/**
 * Fetches the room tone ahead of time, if it is wanted at all. Muted means
 * muted: a player who turned it off does not pay to download it. See
 * `preload.ts`.
 */
export function primeAmbience(): void {
  if (ambienceWanted()) ensureAmbience();
}

/** On in its own right, and not silenced by the main sound switch. */
function ambienceWanted(): boolean {
  return sound.isEnabled() && ambience.isEnabled();
}

function syncAmbience(): void {
  if (ambienceWanted()) startAmbience();
  else stopAmbience();
}

function startAmbience(): void {
  if (!started) return;
  const audio = ensureAmbience();
  if (audio) play(audio);
}

function stopAmbience(): void {
  ambienceAudio?.pause();
}

// ---------------------------------------------------------------------------
// Music — a shuffled-forever playlist.

let musicAudio: HTMLAudioElement | undefined;
let current: Track | undefined;
const nowPlayingListeners = new Set<() => void>();

export const music = {
  ...createToggle('caravan.music', () => syncMusic()),
  available: (): boolean => tracks.length > 0,
  /** The track playing right now, as a store the header can title itself from. */
  subscribeNowPlaying(listener: () => void): () => void {
    nowPlayingListeners.add(listener);
    return () => nowPlayingListeners.delete(listener);
  },
  nowPlaying: (): Track | undefined => current,
  /** Skip. Silently does nothing when the music is muted or there is none. */
  next(): void {
    if (!musicWanted() || tracks.length === 0) return;
    advance();
  },
};

/**
 * Picks a track at random, never the one just heard. With a single track in the
 * folder that necessarily means repeating it.
 */
function advance(): void {
  const pool = tracks.length > 1 ? tracks.filter((t) => t.url !== current?.url) : tracks;
  current = pool[Math.floor(Math.random() * pool.length)]!;
  for (const listener of nowPlayingListeners) listener();

  if (!musicAudio) {
    musicAudio = new Audio();
    musicAudio.volume = MUSIC_VOLUME;
    // The playlist is the `ended` handler: one track finishing is what chooses
    // the next. Nothing schedules ahead, so a skip cannot double up.
    musicAudio.addEventListener('ended', () => {
      if (musicWanted()) advance();
    });
  }
  musicAudio.src = current.url;
  play(musicAudio);
}

function startMusic(): void {
  if (tracks.length === 0 || !started) return;
  // Resume where a mute left off rather than losing the track to a stray click.
  if (musicAudio && current) play(musicAudio);
  else advance();
}

function stopMusic(): void {
  musicAudio?.pause();
}

/** On in its own right, and not silenced by the main sound switch. */
function musicWanted(): boolean {
  return sound.isEnabled() && music.isEnabled();
}

function syncMusic(): void {
  if (musicWanted()) startMusic();
  else stopMusic();
}

// The main switch silences both loops and, turned back on, resumes whichever
// were on before.
sound.subscribe(() => {
  syncAmbience();
  syncMusic();
});

// ---------------------------------------------------------------------------

/** `play()` returns a promise in browsers and nothing at all under jsdom. */
function play(audio: HTMLAudioElement): void {
  try {
    void (audio.play() as Promise<void> | undefined)?.catch(() => {});
  } catch {
    // An environment with no audio output at all. Nothing to recover.
  }
}

let started = false;

/**
 * Opens the gate. Called from the first real user gesture, because that is the
 * only moment a browser will let unprompted audio begin — and called again on
 * later gestures costs nothing, since `play()` on something already playing is
 * a no-op.
 */
export function startBackgroundAudio(): void {
  started = true;
  if (ambienceWanted()) startAmbience();
  if (musicWanted()) startMusic();
}

// `pointerdown` rather than `click` so that pressing the music button counts as
// the gesture that opened the gate before its own handler runs.
if (typeof document !== 'undefined') {
  const arm = () => startBackgroundAudio();
  document.addEventListener('pointerdown', arm, { once: true });
  document.addEventListener('keydown', arm, { once: true });
}

if (import.meta.env.DEV) {
  console.info(`[music] ${tracks.length} tracks, ambience ${ambienceTrack ? 'yes' : 'no'}`);
}
