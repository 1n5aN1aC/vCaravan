import { NET, type Difficulty } from '@caravan/protocol';
import type { DeckModeId, MatchState, Move, Seat } from '@caravan/rules';

export interface Room {
  code: string;
  seed: string;
  /** The AI's difficulty when seat 1 is a bot, null for a two-human table. */
  bot: Difficulty | null;
  /** Which cards both seats build from. Fixed when the table is created. */
  mode: DeckModeId;
  state: MatchState | null;
  /** Per seat: the built deck's kept card ids, or null while still building.
      Part of the replay record — the deal depends on it as much as the seed. */
  decks: [string[] | null, string[] | null];
  /** Recorded for deterministic replay: seed + decks + moves reproduces the match. */
  moves: Array<{ seat: Seat; move: Move }>;
  /** Which seats have been claimed, and when each last went quiet. */
  claimed: [boolean, boolean];
  /** Per seat: has that seat offered a rematch of the match just finished. */
  rematch: [boolean, boolean];
  disconnectedAt: [number | null, number | null];
  lastActivity: number;
  ended: boolean;
}

/**
 * Rooms live in the host's browser tab. Behind an interface so tests can watch
 * the store directly; the tab persists its one room itself (see the web app's
 * `HostTable`), since a refresh is the only restart there is.
 */
export interface MatchStore {
  create(room: Room): void;
  get(code: string): Room | undefined;
  delete(code: string): void;
  all(): Room[];
}

export class InMemoryMatchStore implements MatchStore {
  private rooms = new Map<string, Room>();

  create(room: Room): void {
    this.rooms.set(room.code, room);
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  delete(code: string): void {
    this.rooms.delete(code);
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O — they read as 1 and 0

/**
 * A uniform integer in `[0, n)` from the platform CSPRNG. Web Crypto rather than
 * `node:crypto`, because this runs in the host's browser; rejection sampling
 * rather than `%`, which would favour the low values.
 */
function randomIndex(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const word = new Uint32Array(1);
  do crypto.getRandomValues(word);
  while (word[0]! >= limit);
  return word[0]! % n;
}

function randomHex(bytes: number): string {
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(buffer, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateCode(taken: (code: string) => boolean): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = '';
    for (let i = 0; i < NET.ROOM_CODE_LENGTH; i++) {
      code += ALPHABET[randomIndex(ALPHABET.length)];
    }
    if (!taken(code)) return code;
  }
  throw new Error('could not allocate a free room code');
}

export function generateSeed(): string {
  return randomHex(8);
}

/**
 * Seat tokens are random secrets the host keeps, one per seat, handed to whoever
 * takes the seat and asked back of whoever wants it again. The room code and
 * seat are readable; the secret is what proves the claim.
 *
 * Not an HMAC any more: the browser's HMAC is async, and the host has to
 * persist its room across a refresh anyway — the secrets simply go with it.
 */
export class SeatTokens {
  /** `${code}.${seat}` -> that seat's secret. */
  private secrets: Map<string, string>;

  constructor(entries: Iterable<[string, string]> = []) {
    this.secrets = new Map(entries);
  }

  /** The seat's token. The same one every time, so a resume does not rotate it. */
  issue(code: string, seat: Seat): string {
    const body = `${code}.${seat}`;
    let secret = this.secrets.get(body);
    if (!secret) {
      secret = randomHex(16);
      this.secrets.set(body, secret);
    }
    return `${body}.${secret}`;
  }

  verify(token: string): { code: string; seat: Seat } | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [code, seatText, secret] = parts as [string, string, string];
    const expected = this.secrets.get(`${code}.${seatText}`);
    if (!expected || !sameText(secret, expected)) return null;
    const seat = Number(seatText);
    if (seat !== 0 && seat !== 1) return null;
    return { code, seat };
  }

  /** Drops a room's secrets once the room is gone. */
  forget(code: string): void {
    for (const key of [...this.secrets.keys()]) {
      if (key.startsWith(`${code}.`)) this.secrets.delete(key);
    }
  }

  /** Everything needed to rebuild this after a refresh. */
  entries(): Array<[string, string]> {
    return [...this.secrets];
  }
}

/** Compares without bailing at the first difference. */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
