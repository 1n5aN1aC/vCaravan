import { PeerError, type Channel, type Listener, type PeerNetwork } from '../src/peer.js';

/**
 * PeerJS without the broker or WebRTC: ids registered in a map, and channels
 * that hand each message straight to the other end, JSON round-tripped the way
 * PeerJS's `json` serialization would. Delivery is synchronous, so a test sees
 * the effect of a send on the very next line.
 */
export class MemoryNetwork implements PeerNetwork {
  private registered = new Map<string, (channel: Channel) => void>();
  /** Every channel ever opened from the dialling side, newest last. */
  readonly dialled: MemoryChannel[] = [];

  async listen(id: string, onChannel: (channel: Channel) => void): Promise<Listener> {
    if (this.registered.has(id)) throw new PeerError('taken', 'taken');
    this.registered.set(id, onChannel);
    return {
      onstatus: null,
      close: () => {
        if (this.registered.get(id) === onChannel) this.registered.delete(id);
      },
    };
  }

  async connect(id: string): Promise<Channel> {
    const onChannel = this.registered.get(id);
    if (!onChannel) throw new PeerError('unreachable', 'no table with that code');
    const [near, far] = MemoryChannel.pair();
    onChannel(far);
    this.dialled.push(near);
    return near;
  }

  /** Whether anything is registered under `id` right now. */
  has(id: string): boolean {
    return this.registered.has(id);
  }
}

export class MemoryChannel implements Channel {
  onmessage: ((message: unknown) => void) | null = null;
  onclose: (() => void) | null = null;
  /** Everything sent from this end. */
  readonly sent: unknown[] = [];
  private other: MemoryChannel | null = null;
  private closed = false;

  static pair(): [MemoryChannel, MemoryChannel] {
    const a = new MemoryChannel();
    const b = new MemoryChannel();
    a.other = b;
    b.other = a;
    return [a, b];
  }

  send(message: unknown): void {
    if (this.closed) return;
    this.sent.push(message);
    this.other?.onmessage?.(JSON.parse(JSON.stringify(message)));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
    this.other?.close();
  }
}

/** A Storage that is just a map, so tests never share a tab's session. */
export class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}
