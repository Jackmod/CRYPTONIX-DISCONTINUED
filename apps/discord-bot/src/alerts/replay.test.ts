import { describe, it, expect, vi } from 'vitest';
import { AlertReplay } from './replay';
import type { AlertEvent } from '../engine/alert-stream';

const PAGE = 5;

function alert(id: number): AlertEvent {
  return { id, type: 'wallet_buy', refId: id, payload: { id } };
}

/** An engine holding `count` alerts, served ascending and capped at PAGE. */
function build(count: number, overrides: Partial<Parameters<typeof AlertReplay>[0]> = {}) {
  const stored = Array.from({ length: count }, (_, i) => alert(i + 1));
  const posted: number[] = [];

  const listAlertsSince = vi.fn(async (since: number) =>
    stored.filter((a) => a.id > since).slice(0, PAGE)
  );

  const replay = new AlertReplay({
    listAlertsSince,
    getAlertHead: vi.fn(async () => stored.reduce((max, a) => Math.max(max, a.id), 0)),
    deliver: vi.fn(async (a: AlertEvent) => {
      posted.push(a.id);
    }),
    pageSize: PAGE,
    ...overrides,
  } as never);

  return { replay, posted, stored, listAlertsSince };
}

describe('AlertReplay: starting', () => {
  it('resumes from the engine head, not from zero', async () => {
    // Starting at 0 replays the entire alert history into live channels.
    const { replay, posted } = build(12);

    await replay.start();
    expect(replay.resumeFrom).toBe(12);

    await replay.catchUp();
    expect(posted).toEqual([]);
  });

  it('does not arm delivery until the head is actually known', async () => {
    // Arming with a fallback of 0 after a failed read defeats the guard: the
    // first catch-up would replay the oldest page into every channel.
    const getAlertHead = vi
      .fn()
      .mockRejectedValueOnce(new Error('engine down'))
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValueOnce(9);
    const { replay, posted } = build(9, { getAlertHead });

    await replay.start(0, async () => {});

    expect(getAlertHead).toHaveBeenCalledTimes(3);
    expect(replay.resumeFrom).toBe(9);
    await replay.catchUp();
    expect(posted).toEqual([]);
  });

  it('refuses to catch up before it has started', async () => {
    const { replay, posted } = build(20);

    expect(await replay.catchUp()).toBe(0);
    expect(posted).toEqual([]);
  });
});

describe('AlertReplay: pagination', () => {
  it('walks every page of a backlog larger than the cap', async () => {
    // The bug this guards: the cursor advanced per alert, so the page-progress
    // check tripped immediately and the walk stopped after one page -- a
    // 120-alert backlog replayed only the first 50.
    //
    // Modelled the way it really happens: the bot starts against an empty
    // engine, then 12 alerts accumulate while it is disconnected.
    const { replay, posted, listAlertsSince } = build(12, { getAlertHead: vi.fn(async () => 0) });
    await replay.start();

    await replay.catchUp();

    expect(posted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(listAlertsSince.mock.calls.length).toBeGreaterThanOrEqual(3); // 5 + 5 + 2
    expect(replay.resumeFrom).toBe(12);
  });

  it('stops on an exactly-full final page without looping forever', async () => {
    const { replay, posted } = build(PAGE, { getAlertHead: vi.fn(async () => 0) });
    await replay.start();

    await replay.catchUp();

    expect(posted).toEqual([1, 2, 3, 4, 5]);
  });

  it('stops if a page makes no forward progress', async () => {
    // A misbehaving engine returning the same rows must not spin the loop.
    // The page must be EXACTLY pageSize, or the walk exits through the
    // short-page break and never reaches the guard this test is about --
    // deleting the guard would then leave the suite green.
    const samePageForever = Array.from({ length: PAGE }, (_, i) => alert(i + 1));
    let calls = 0;
    const stuck = vi.fn(async () => {
      // Fail loudly rather than looping forever: without the bound, removing
      // the guard hangs the worker instead of failing this test.
      if (++calls > 10) throw new Error('catchUp did not stop on a page that made no progress');
      return samePageForever;
    });
    const replay = new AlertReplay({
      listAlertsSince: stuck,
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async () => {}),
      pageSize: PAGE,
    });
    await replay.start();

    await replay.catchUp();

    // Two calls: one that advances the cursor to 5, one that cannot beat it.
    expect(stuck).toHaveBeenCalledTimes(2);
  });
});

describe('AlertReplay: live and catch-up together', () => {
  it('never posts the same alert twice', async () => {
    const { replay, posted } = build(3, { getAlertHead: vi.fn(async () => 0) });
    await replay.start();

    // The overlap that really happens: catch-up is walking the backlog when a
    // live copy of one of those same alerts arrives.
    const walking = replay.catchUp();
    await replay.handleLive(alert(2));
    await walking;

    expect(posted.filter((id) => id === 2)).toHaveLength(1);
    expect([...posted].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('does not let a live alert push the cursor past unfetched ids', async () => {
    // The bug this guards: a live alert raising the shared cursor mid-walk
    // made every id between the walk's position and that alert unreachable.
    const { replay, posted } = build(6, { getAlertHead: vi.fn(async () => 0) });
    await replay.start();

    // A live alert for the newest id lands while the walk is in progress. If
    // it moved the shared cursor, every id the walk had not yet reached would
    // be skipped for good.
    const walking = replay.catchUp();
    await replay.handleLive(alert(6));
    await walking;

    expect([...posted].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('queues live alerts during a catch-up and drains them after', async () => {
    let release: (value: unknown) => void = () => {};
    const gate = new Promise((resolve) => (release = resolve));
    const stored = [alert(1), alert(2)];

    const posted: number[] = [];
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async (since: number) => {
        if (since === 0) await gate; // hold the first page open
        return stored.filter((a) => a.id > since).slice(0, PAGE);
      }),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async (a: AlertEvent) => {
        posted.push(a.id);
      }),
      pageSize: PAGE,
    });
    await replay.start();

    const walking = replay.catchUp();
    await replay.handleLive(alert(3)); // arrives mid-walk
    expect(posted).toEqual([]); // queued, not posted out of order

    release(undefined);
    await walking;

    expect(posted).toEqual([1, 2, 3]);
  });

  it('advances the cursor from live alerts once the backlog is clear', async () => {
    const { replay } = build(0, { getAlertHead: vi.fn(async () => 0) });
    await replay.start();

    await replay.handleLive(alert(4));

    expect(replay.resumeFrom).toBe(4);
  });

  it('skips one undeliverable alert and keeps posting the rest', async () => {
    // Aborting the walk on a single failure was worse than skipping: the
    // cursor never passed the bad alert, so every later reconnect refetched
    // the same page, died on the same alert, and nothing behind it ever
    // arrived.
    const posted: number[] = [];
    const stored = [alert(1), alert(2), alert(3)];
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async (since: number) => stored.filter((a) => a.id > since).slice(0, PAGE)),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async (a: AlertEvent) => {
        if (a.id === 2) throw new Error('unrenderable payload');
        posted.push(a.id);
      }),
      pageSize: PAGE,
    });
    await replay.start();

    await expect(replay.catchUp()).resolves.toBe(2);

    expect(posted).toEqual([1, 3]);
    expect(replay.resumeFrom).toBe(3); // the walk moved past the bad alert
  });

  it('still drains queued live alerts when the walk itself throws', async () => {
    // The drain used to sit outside the try, so a failing listAlertsSince
    // stranded everything queued behind it until some future clean catch-up.
    const posted: number[] = [];
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async () => {
        throw new Error('engine died mid-walk');
      }),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async (a: AlertEvent) => {
        posted.push(a.id);
      }),
      pageSize: PAGE,
    });
    await replay.start();

    const walking = replay.catchUp();
    await replay.handleLive(alert(9));
    await expect(walking).rejects.toThrow('engine died mid-walk');

    expect(posted).toEqual([9]);
  });

  it('does not let a live alert jump the cursor after an aborted walk', async () => {
    // Mid-walk is covered above; this is the window after the walk has died,
    // when ids below the failure point are still unfetched.
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async () => {
        throw new Error('engine died mid-walk');
      }),
      getAlertHead: vi.fn(async () => 50),
      deliver: vi.fn(async () => {}),
      pageSize: PAGE,
    });
    await replay.start();
    expect(replay.resumeFrom).toBe(50);

    await expect(replay.catchUp()).rejects.toThrow();
    await replay.handleLive(alert(56));

    // Still 50: ids 51-55 were never fetched and must stay reachable.
    expect(replay.resumeFrom).toBe(50);
  });

  it('forgets only the oldest ids when the de-duplication set fills', async () => {
    const posted: number[] = [];
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async () => []),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async (a: AlertEvent) => {
        posted.push(a.id);
      }),
      pageSize: PAGE,
      maxRememberedIds: 3,
    });
    await replay.start();

    for (const id of [1, 2, 3, 4]) await replay.handleLive(alert(id));
    await replay.handleLive(alert(4)); // still remembered
    expect(posted).toEqual([1, 2, 3, 4]);
  });
});
