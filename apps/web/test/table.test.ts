import { hydrateForClient, type RedactedState } from '@caravan/protocol';
import { buildDeck, listLegalMoves, type Seat } from '@caravan/rules';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaravanClient } from '../src/net.js';
import { peerIdFor } from '../src/table.js';
import { MemoryNetwork, MemoryStorage } from './memoryNetwork.js';

/**
 * Two tabs, a host and a guest, over an in-memory stand-in for PeerJS — the
 * automated form of "open the game in two browsers and play a match". Only the
 * broker and WebRTC are faked; the host's table, both clients and every message
 * between them are the real thing.
 */

let network: MemoryNetwork;
const tabs: CaravanClient[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
  network = new MemoryNetwork();
});

afterEach(() => {
  for (const tab of tabs.splice(0)) tab.dispose();
  vi.useRealTimers();
});

function tab(storage: Storage = new MemoryStorage()): CaravanClient {
  const client = new CaravanClient({ network, storage });
  client.start();
  tabs.push(client);
  return client;
}

/** Lets queued deliveries and pending promises run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function seatedPair(): Promise<{ host: CaravanClient; guest: CaravanClient; code: string }> {
  const host = tab();
  await host.createRoom(undefined, 'build');
  await settle();
  const code = host.state.code!;

  const guest = tab();
  guest.joinRoom(code);
  await settle();

  host.submitDeck(buildDeck(0).map((c) => c.id));
  guest.submitDeck(buildDeck(1).map((c) => c.id));
  await settle();
  return { host, guest, code };
}

describe('a table over PeerJS', () => {
  it('registers the host under its code and seats a guest who dials it', async () => {
    const { host, guest, code } = await seatedPair();
    expect(code).toMatch(/^[A-Z]{6}$/);
    expect(network.has(peerIdFor(code))).toBe(true);
    expect(host.state).toMatchObject({ seat: 0, hosting: true, connectivity: 'open' });
    expect(guest.state).toMatchObject({ seat: 1, hosting: false, connectivity: 'open' });
    expect(host.state.status).toBe('playing');
    expect(guest.state.match).not.toBeNull();
  });

  it('plays a complete match to a result both tabs agree on', async () => {
    const { host, guest } = await seatedPair();
    const tabsBySeat: [CaravanClient, CaravanClient] = [host, guest];
    let plies = 0;

    for (let ply = 0; ply < 400; ply++) {
      const view = host.state.match!;
      if (view.result) break;
      const seat = view.turn as Seat;
      const mover = tabsBySeat[seat];
      // Each tab picks from its own redacted view — the same path the board
      // uses to highlight legal targets.
      const legal = listLegalMoves(hydrateForClient(mover.state.match!), seat);
      expect(legal.length).toBeGreaterThan(0);
      mover.play(legal[ply % legal.length]!);
      await settle();
      plies++;
    }

    expect(host.state.error).toBeNull();
    expect(guest.state.error).toBeNull();
    expect(host.state.match!.result).not.toBeNull();
    expect(guest.state.match!.result).toEqual(host.state.match!.result);
    expect(guest.state.match!.players[0].caravans).toEqual(host.state.match!.players[0].caravans);
    expect(plies).toBeGreaterThan(0);
  });

  it('never sends the guest the host’s hand or either deck', async () => {
    const received: unknown[] = [];
    const host = tab();
    await host.createRoom(undefined, 'build');
    await settle();
    const guest = tab();
    guest.joinRoom(host.state.code!);
    await settle();
    // Everything the host sends this guest arrives at the guest's end of the
    // channel, as plain JSON — exactly what would cross the wire.
    const end = network.dialled[0]!;
    const deliver = end.onmessage!;
    end.onmessage = (message) => {
      received.push(message);
      deliver(message);
    };
    host.submitDeck(buildDeck(0).map((c) => c.id));
    guest.submitDeck(buildDeck(1).map((c) => c.id));
    await settle();

    const states = received.filter((m) => (m as { t: string }).t === 'state');
    expect(states.length).toBeGreaterThan(0);
    for (const message of states) {
      const view = (message as { state: RedactedState }).state;
      expect(view.players[0].hand).toBeNull();
      expect(view.players[1].hand).not.toBeNull();
    }
    expect(JSON.stringify(received)).not.toContain('"deck"');
  });

  it('refuses a guest trying to open a room in the host’s tab', async () => {
    const { code } = await seatedPair();
    const replies: unknown[] = [];
    const channel = await network.connect(peerIdFor(code));
    channel.onmessage = (message) => replies.push(message);
    channel.send({ t: 'create', bot: 'easy' });
    channel.send({ t: 'move', move: { type: 'play' } });
    expect(replies).toEqual([
      { t: 'error', message: 'invalid message', resync: false },
      { t: 'error', message: 'invalid message', resync: false },
    ]);
  });

  it('turns a third tab away', async () => {
    const { code } = await seatedPair();
    const third = tab();
    third.joinRoom(code);
    await settle();
    expect(third.state.seat).toBeNull();
    expect(third.state.error).toMatch(/full/);
    expect(third.state.connectivity).toBe('idle');
  });

  it('says so when no table has that code', async () => {
    const guest = tab();
    guest.joinRoom('QQQQQQ');
    await settle();
    expect(guest.state.error).toMatch(/No table with that code/);
    expect(guest.state.connectivity).toBe('idle');
  });

  it('ends the table for the guest when the host leaves', async () => {
    const { host, guest, code } = await seatedPair();
    host.leave();
    await settle();
    expect(guest.state.status).toBe('ended');
    expect(guest.state.endedReason).toBe('opponent-left');
    expect(host.state.seat).toBeNull();
    // The code is let go once the goodbye has had time to cross.
    vi.advanceTimersByTime(2_000);
    expect(network.has(peerIdFor(code))).toBe(false);
  });
});

describe('refreshing', () => {
  it('puts a guest back in its seat after its link drops', async () => {
    const { guest, host } = await seatedPair();
    const board = JSON.stringify(guest.state.match!.players);
    network.dialled[0]!.close();
    await settle();
    expect(guest.state.connectivity).toBe('closed');
    expect(host.state.present).toEqual([true, false]);

    vi.advanceTimersByTime(3_000);
    await settle();
    expect(guest.state.connectivity).toBe('open');
    expect(guest.state.seat).toBe(1);
    expect(JSON.stringify(guest.state.match!.players)).toBe(board);
    expect(host.state.present).toEqual([true, true]);
  });

  it('brings a host’s table back after a reload, and the guest finds it again', async () => {
    const storage = new MemoryStorage();
    const host = tab(storage);
    await host.createRoom(undefined, 'build');
    await settle();
    const code = host.state.code!;
    const guest = tab();
    guest.joinRoom(code);
    await settle();
    host.submitDeck(buildDeck(0).map((c) => c.id));
    guest.submitDeck(buildDeck(1).map((c) => c.id));
    await settle();
    const board = JSON.stringify(host.state.match!.players);

    // The tab goes away without leaving — a reload, as far as anyone can tell.
    host.dispose();
    expect(guest.state.connectivity).toBe('closed');

    const reloaded = tab(storage);
    await settle();
    expect(reloaded.state).toMatchObject({ code, seat: 0, hosting: true });
    expect(JSON.stringify(reloaded.state.match!.players)).toBe(board);

    vi.advanceTimersByTime(3_000);
    await settle();
    expect(guest.state.connectivity).toBe('open');
    expect(reloaded.state.present).toEqual([true, true]);
  });

  it('lets a guest go once the host has been gone past the grace window', async () => {
    const { host, guest } = await seatedPair();
    host.dispose();
    for (let waited = 0; waited <= 95_000; waited += 3_000) {
      vi.advanceTimersByTime(3_000);
      await settle();
    }
    expect(guest.state.status).toBe('ended');
    expect(guest.state.match).not.toBeNull();
  });
});

describe('a solo table', () => {
  it('runs entirely in the tab, never touching the network', async () => {
    const listen = vi.spyOn(network, 'listen');
    const solo = tab();
    await solo.createRoom('easy', 'classic');
    await settle();
    expect(listen).not.toHaveBeenCalled();
    expect(solo.state).toMatchObject({ seat: 0, connectivity: 'local', status: 'building' });
  });
});

