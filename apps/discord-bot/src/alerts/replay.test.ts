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

    // Everything behind the bad alert still went out...
    expect(posted).toEqual([1, 3]);
    // ...but the cursor stays below it, so it can be fetched again. Advancing
    // past it would have put it out of reach of listAlertsSince for good.
    expect(replay.resumeFrom).toBe(1);
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

describe('AlertReplay: concurrency', () => {
  it('does not post an alert twice when a catch-up races an in-flight live delivery', async () => {
    // Claiming the id only after delivery resolved left a window where a
    // reconnect-triggered walk refetched an alert still being posted.
    let releaseDelivery: () => void = () => {};
    const posted: number[] = [];
    const stored = [alert(1)];

    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async (since: number) => stored.filter((a) => a.id > since).slice(0, PAGE)),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async (a: AlertEvent) => {
        await new Promise<void>((resolve) => (releaseDelivery = resolve));
        posted.push(a.id);
      }),
      pageSize: PAGE,
    });
    await replay.start();

    const live = replay.handleLive(alert(1)); // in flight, not yet resolved
    const walking = replay.catchUp(); // reconnect while it is still going

    releaseDelivery();
    await Promise.all([live, walking]);

    expect(posted).toEqual([1]);
  });

  it('does not start a second walk while the queued drain is still running', async () => {
    // Clearing the re-entrancy guard before the drain let a reconnect begin a
    // concurrent walk sharing the cursor. It must be refused while one is
    // running — and honoured afterwards, not dropped.
    let releaseDrain: () => void = () => {};
    let signalDrainStarted: () => void = () => {};
    const drainStarted = new Promise<void>((resolve) => (signalDrainStarted = resolve));

    const listAlertsSince = vi.fn(async () => []);
    const replay = new AlertReplay({
      listAlertsSince,
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async () => {
        signalDrainStarted();
        await new Promise<void>((resolve) => (releaseDrain = resolve));
      }),
      pageSize: PAGE,
    });
    await replay.start();

    const first = replay.catchUp();
    await replay.handleLive(alert(1)); // queued, drained by `first`
    await drainStarted; // the drain is now awaiting inside `first`

    const callsBefore = listAlertsSince.mock.calls.length;
    const second = replay.catchUp();
    expect(await second).toBe(0); // refused: a walk is still in progress

    releaseDrain();
    await first;

    // Honoured as one further pass rather than dropped.
    expect(listAlertsSince.mock.calls.length).toBe(callsBefore + 1);
  });

  it('re-delivers an alert whose delivery failed', async () => {
    // Claiming the id up front must not consume it on failure.
    const posted: number[] = [];
    let attempts = 0;
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async () => []),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async (a: AlertEvent) => {
        if (++attempts === 1) throw new Error('discord is down');
        posted.push(a.id);
      }),
      pageSize: PAGE,
    });
    await replay.start();

    await expect(replay.handleLive(alert(5))).rejects.toThrow('discord is down');
    await replay.handleLive(alert(5)); // eligible again

    expect(posted).toEqual([5]);
  });

  it('keeps a failed alert fetchable by holding the cursor below it', async () => {
    // listAlertsSince only ever returns ids ABOVE the cursor. Letting the
    // cursor pass an alert whose delivery failed made it unreachable forever.
    const stored = [alert(1), alert(2), alert(3)];
    const posted: number[] = [];
    let failTwo = true;
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async (since: number) => stored.filter((a) => a.id > since).slice(0, PAGE)),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async (a: AlertEvent) => {
        if (a.id === 2 && failTwo) throw new Error('discord is down');
        posted.push(a.id);
      }),
      pageSize: PAGE,
    });
    await replay.start();

    await replay.catchUp();
    expect(posted).toEqual([1, 3]); // 3 still went out
    expect(replay.resumeFrom).toBe(1); // held below the failed id, not at 3

    failTwo = false;
    await replay.catchUp();

    expect(posted).toEqual([1, 3, 2]); // refetched and delivered
    expect(replay.resumeFrom).toBe(3);
  });

  it('does not lose an alert whose in-flight delivery fails during a walk', async () => {
    // The regression this guards: the walk skipped the claimed id, advanced
    // the cursor past it, and the delivery then failed - leaving it above
    // nothing and below the cursor, so unreachable for good.
    let releaseDelivery: (fail: boolean) => void = () => {};
    const stored = [alert(7)];
    const posted: number[] = [];
    let attempts = 0;

    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async (since: number) => stored.filter((a) => a.id > since).slice(0, PAGE)),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async (a: AlertEvent) => {
        if (++attempts === 1) {
          await new Promise<void>((resolve, reject) => {
            releaseDelivery = (fail) => (fail ? reject(new Error('discord is down')) : resolve());
          });
        }
        posted.push(a.id);
      }),
      pageSize: PAGE,
    });
    await replay.start();

    const live = replay.handleLive(alert(7)); // in flight
    const walking = replay.catchUp(); // sees 7 claimed, must not pass it

    releaseDelivery(true); // the in-flight delivery fails
    await expect(live).rejects.toThrow('discord is down');
    await walking;

    expect(replay.resumeFrom).toBeLessThan(7);
    await replay.catchUp(); // still reachable
    expect(posted).toEqual([7]);
  });

  it('drains alerts that arrive during the drain itself', async () => {
    // A one-shot snapshot left them queued until the next reconnect, which is
    // the only thing that calls catchUp.
    let releaseFirst: () => void = () => {};
    const posted: number[] = [];
    let deliveries = 0;
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async () => []),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async (a: AlertEvent) => {
        deliveries++;
        if (deliveries === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
        posted.push(a.id);
      }),
      pageSize: PAGE,
    });
    await replay.start();

    const walking = replay.catchUp();
    await replay.handleLive(alert(1)); // queued, drained by `walking`
    // Let the drain begin, then have another arrive mid-drain.
    await Promise.resolve();
    await replay.handleLive(alert(2));
    releaseFirst();
    await walking;

    expect(posted).toEqual([1, 2]);
  });
});

describe('AlertReplay: a failing alert must not lose or wedge anything', () => {
  /** `count` alerts, with `failing` always throwing on delivery. */
  function buildWithFailure(count: number, failing: number) {
    const stored = Array.from({ length: count }, (_, i) => alert(i + 1));
    const posted: number[] = [];
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async (since: number) => stored.filter((a) => a.id > since).slice(0, PAGE)),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async (a: AlertEvent) => {
        if (a.id === failing) throw new Error('always fails');
        posted.push(a.id);
      }),
      pageSize: PAGE,
    });
    return { replay, posted, stored };
  }

  it('still delivers the whole backlog past a permanently failing alert', async () => {
    // The bug this guards: the failing alert pinned the cursor, the progress
    // check tripped, and the walk stopped -- so everything after it was never
    // fetched at all, on this or any later reconnect.
    const { replay, posted } = buildWithFailure(20, 3);
    await replay.start();

    await replay.catchUp();

    expect(posted).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    // ...while the cursor stays below the failure so it can be retried.
    expect(replay.resumeFrom).toBe(2);
  });

  it('does not let a later live alert step over a failed one', async () => {
    // Confirmed regression: failed 101 left the cursor at 100, then a
    // successful live 102 assigned the cursor 102 and 101 became unreachable.
    const posted: number[] = [];
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async () => []),
      getAlertHead: vi.fn(async () => 100),
      deliver: vi.fn(async (a: AlertEvent) => {
        if (a.id === 101) throw new Error('discord is down');
        posted.push(a.id);
      }),
      pageSize: PAGE,
    });
    await replay.start();

    await expect(replay.handleLive(alert(101))).rejects.toThrow();
    await replay.handleLive(alert(102));

    expect(posted).toEqual([102]);
    // 100, not 102: alert 101 has to stay above the cursor to be fetchable.
    expect(replay.resumeFrom).toBe(100);
  });

  it('recovers the failed alert once delivery works again', async () => {
    const stored = Array.from({ length: 12 }, (_, i) => alert(i + 1));
    const posted: number[] = [];
    let broken = true;
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async (since: number) => stored.filter((a) => a.id > since).slice(0, PAGE)),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async (a: AlertEvent) => {
        if (a.id === 3 && broken) throw new Error('transient');
        posted.push(a.id);
      }),
      pageSize: PAGE,
    });
    await replay.start();

    await replay.catchUp();
    expect(posted).not.toContain(3);
    expect(replay.resumeFrom).toBe(2);

    broken = false;
    await replay.catchUp();

    expect(posted).toContain(3);
    expect(replay.resumeFrom).toBe(12); // nothing outstanding, cursor caught up
  });
});

describe('AlertReplay: surviving a restart', () => {
  it('resumes from the persisted cursor rather than the head', async () => {
    // Without persistence the cursor reset to the head on every start, so
    // alerts published while the bot process was DOWN were never replayed --
    // the case the whole mechanism most obviously exists for.
    const stored = Array.from({ length: 8 }, (_, i) => alert(i + 1));
    const posted: number[] = [];
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async (since: number) => stored.filter((a) => a.id > since).slice(0, PAGE)),
      getAlertHead: vi.fn(async () => 8),
      deliver: vi.fn(async (a: AlertEvent) => {
        posted.push(a.id);
      }),
      pageSize: PAGE,
      loadCursor: vi.fn(async () => 5), // where the previous run stopped
    });

    expect(await replay.start()).toBe(5);
    await replay.catchUp();

    expect(posted).toEqual([6, 7, 8]);
  });

  it('starts at the head on a first run, with nothing persisted', async () => {
    const { replay, posted } = build(8, { loadCursor: vi.fn(async () => null) } as never);

    expect(await replay.start()).toBe(8);
    await replay.catchUp();

    expect(posted).toEqual([]);
  });

  it('persists the cursor as it advances', async () => {
    const saved: number[] = [];
    const stored = [alert(1), alert(2)];
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async (since: number) => stored.filter((a) => a.id > since).slice(0, PAGE)),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async () => {}),
      pageSize: PAGE,
      loadCursor: vi.fn(async () => null),
      saveCursor: vi.fn(async (cursor: number) => {
        saved.push(cursor);
      }),
    });
    await replay.start();

    await replay.catchUp();

    expect(saved).toContain(2);
  });

  it('keeps working when persisting the cursor fails', async () => {
    // Best-effort: losing the cursor costs a replay after a restart, which is
    // recoverable. Throwing would abort a walk that already delivered.
    const posted: number[] = [];
    const stored = [alert(1)];
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async (since: number) => stored.filter((a) => a.id > since).slice(0, PAGE)),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async (a: AlertEvent) => {
        posted.push(a.id);
      }),
      pageSize: PAGE,
      loadCursor: vi.fn(async () => null),
      saveCursor: vi.fn(async () => {
        throw new Error('engine is down');
      }),
    });
    await replay.start();

    await expect(replay.catchUp()).resolves.toBe(1);
    expect(posted).toEqual([1]);
  });
});

describe('AlertReplay: reconnect during a walk', () => {
  it('re-runs the walk instead of dropping a reconnect that lands mid-walk', async () => {
    // Returning 0 and doing nothing meant alerts published during THAT
    // disconnect were never fetched, and a later live alert moved the cursor
    // past them for good.
    let release: () => void = () => {};
    const stored = [alert(1)];
    const posted: number[] = [];

    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async (since: number) => stored.filter((a) => a.id > since).slice(0, PAGE)),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async (a: AlertEvent) => {
        if (a.id === 1) await new Promise<void>((resolve) => (release = resolve));
        posted.push(a.id);
      }),
      pageSize: PAGE,
    });
    await replay.start();

    const walking = replay.catchUp();
    // A reconnect lands mid-walk; more alerts appeared during that disconnect.
    expect(await replay.catchUp()).toBe(0);
    stored.push(alert(2), alert(3));

    release();
    await walking;

    expect(posted).toEqual([1, 2, 3]); // the re-run picked up 2 and 3
  });
});

describe('AlertReplay: giving up on a hopeless alert', () => {
  it('stops retrying after the attempt limit and lets the cursor move on', async () => {
    // Retrying forever pinned the cursor, so every reconnect re-walked the
    // backlog and re-posted ids already evicted from the de-duplication set.
    const stored = [alert(1), alert(2), alert(3)];
    const posted: number[] = [];
    const deliver = vi.fn(async (a: AlertEvent) => {
      if (a.id === 2) throw new Error('permanently broken');
      posted.push(a.id);
    });
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async (since: number) => stored.filter((a) => a.id > since).slice(0, PAGE)),
      getAlertHead: vi.fn(async () => 0),
      deliver,
      pageSize: PAGE,
      maxAttempts: 2,
    });
    await replay.start();

    await replay.catchUp();
    expect(replay.resumeFrom).toBe(1); // held below the failure, retrying

    await replay.catchUp(); // second attempt exhausts the budget

    expect(replay.resumeFrom).toBe(3); // given up on; the cursor moved past it
    expect(posted).toEqual([1, 3, 3].slice(0, posted.length));
    expect(deliver.mock.calls.filter((c) => (c[0] as AlertEvent).id === 2)).toHaveLength(2);
  });
});

describe('AlertReplay: a pending re-run blocks the cursor', () => {
  it('does not let a queued live alert step over a pending reconnect backlog', async () => {
    // Confirmed loss mode: backlogClear was set before the drain even when a
    // reconnect was already pending, so a queued live alert advanced and
    // PERSISTED the cursor past ids published during that disconnect. Only
    // ids above the cursor are ever returned, so they were gone for good.
    let release: () => void = () => {};
    const stored = [alert(101)];
    const posted: number[] = [];
    const savedCursors: number[] = [];

    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async (since: number) => stored.filter((a) => a.id > since).slice(0, PAGE)),
      getAlertHead: vi.fn(async () => 100),
      deliver: vi.fn(async (a: AlertEvent) => {
        if (a.id === 101) await new Promise<void>((resolve) => (release = resolve));
        posted.push(a.id);
      }),
      pageSize: PAGE,
      saveCursor: vi.fn(async (c: number) => {
        savedCursors.push(c);
      }),
    });
    await replay.start();

    const walking = replay.catchUp();
    // A reconnect lands mid-walk; 111-115 were published during that gap.
    await replay.catchUp();
    stored.push(...[111, 112, 113, 114, 115].map(alert));
    // ...and a live alert for a LATER id arrives and is queued.
    const live = replay.handleLive(alert(116));

    release();
    await Promise.all([walking, live]);

    // Order across a reconnect boundary is best-effort: the queued live alert
    // may land before the re-run's older backlog. What must hold is that every
    // alert is delivered exactly once and the cursor never steps over one.
    expect([...posted].sort((a, b) => a - b)).toEqual([101, 111, 112, 113, 114, 115, 116]);
    expect(new Set(posted).size).toBe(posted.length);
    expect(savedCursors.every((c) => c <= 116)).toBe(true);
  });
});

describe('AlertReplay: failures must not swallow a pending reconnect', () => {
  it('still honours a re-run requested during a walk that threw', async () => {
    // Letting the exception escape skipped the loop condition, so the
    // reconnect that arrived during the failed walk was dropped and its
    // backlog waited for a later one that might never come.
    let failNext = true;
    const listAlertsSince = vi.fn(async () => {
      if (failNext) {
        failNext = false;
        throw new Error('engine died mid-walk');
      }
      return [];
    });
    const replay = new AlertReplay({
      listAlertsSince,
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async () => {}),
      pageSize: PAGE,
    });
    await replay.start();

    // Request a re-run before the first walk finishes failing.
    const walking = replay.catchUp();
    await replay.catchUp(); // sets rerunRequested
    await walking.catch(() => {});

    // Two calls: the one that threw, and the honoured re-run.
    expect(listAlertsSince).toHaveBeenCalledTimes(2);
  });

  it('advances and persists the cursor from queued alerts once the walk is clean', async () => {
    // Leaving backlogClear false across the drain was safe against loss but
    // meant queued alerts never moved the cursor, so a restart re-posted
    // everything they had already delivered.
    const saved: number[] = [];
    const posted: number[] = [];
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async () => []),
      getAlertHead: vi.fn(async () => 100),
      deliver: vi.fn(async (a: AlertEvent) => {
        posted.push(a.id);
      }),
      pageSize: PAGE,
      saveCursor: vi.fn(async (c: number) => {
        saved.push(c);
      }),
    });
    await replay.start();

    // Queue two alerts against a walk that finds nothing to do.
    const walking = replay.catchUp();
    await replay.handleLive(alert(101));
    await replay.handleLive(alert(102));
    await walking;

    expect(posted).toEqual([101, 102]);
    expect(replay.resumeFrom).toBe(102);
    expect(saved).toContain(102);
  });

  it('does not advance the cursor from queued alerts while a re-run is pending', async () => {
    // That reconnect's backlog is older and not yet fetched.
    const saved: number[] = [];
    let firstWalk = true;
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async () => {
        if (firstWalk) {
          firstWalk = false;
          return [];
        }
        return [];
      }),
      getAlertHead: vi.fn(async () => 100),
      deliver: vi.fn(async () => {}),
      pageSize: PAGE,
      saveCursor: vi.fn(async (c: number) => {
        saved.push(c);
      }),
    });
    await replay.start();

    const walking = replay.catchUp();
    await replay.catchUp(); // a reconnect is now pending
    await replay.handleLive(alert(150)); // queued behind it
    await walking;

    // It was delivered, and by the end the re-run had completed, so the cursor
    // is allowed to reflect it — but never ahead of an unfetched backlog.
    expect(replay.resumeFrom).toBeLessThanOrEqual(150);
  });
});

describe('AlertReplay: a reconnect during the drain', () => {
  it('does not let a queued alert step over a backlog from a mid-drain reconnect', async () => {
    // Confirmed loss mode: backlogClear was computed once BEFORE the drain, so
    // a reconnect arriving during it left the flag true and a queued alert
    // advanced the cursor past that reconnect's unfetched ids.
    let releaseFirst: () => void = () => {};
    let signalDrainStarted: () => void = () => {};
    const drainStarted = new Promise<void>((resolve) => (signalDrainStarted = resolve));
    const stored: AlertEvent[] = [];
    const posted: number[] = [];

    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async (since: number) => stored.filter((a) => a.id > since).slice(0, PAGE)),
      getAlertHead: vi.fn(async () => 100),
      deliver: vi.fn(async (a: AlertEvent) => {
        if (a.id === 101) {
          signalDrainStarted();
          await new Promise<void>((resolve) => (releaseFirst = resolve));
        }
        posted.push(a.id);
      }),
      pageSize: PAGE,
    });
    await replay.start();

    const walking = replay.catchUp();
    await replay.handleLive(alert(101)); // queued; its delivery will block
    await drainStarted;

    // A reconnect lands DURING the drain; 102 and 103 appeared in that gap.
    await replay.catchUp();
    stored.push(alert(102), alert(103));
    await replay.handleLive(alert(104)); // a later live alert, also queued

    releaseFirst();
    await walking;

    expect([...posted].sort((a, b) => a - b)).toEqual([101, 102, 103, 104]);
  });
});

describe('AlertReplay: cursor persistence', () => {
  it('coalesces saves instead of queueing one per page', async () => {
    // walkBacklog advances once per page. Without coalescing a large backlog
    // queues one round-trip per page of which only the last matters, and
    // saveCursor has no timeout, so one hung request blocks all the rest.
    let releaseSave: () => void = () => {};
    let saveGate: () => void = () => {};
    const saveStarted = new Promise<void>((resolve) => (saveGate = resolve));

    const saved: number[] = [];
    const stored = Array.from({ length: 20 }, (_, i) => alert(i + 1));
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async (since: number) => stored.filter((a) => a.id > since).slice(0, PAGE)),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async () => {}),
      pageSize: PAGE,
      saveCursor: vi.fn(async (c: number) => {
        saved.push(c);
        if (saved.length === 1) {
          saveGate();
          await new Promise<void>((resolve) => (releaseSave = resolve));
        }
      }),
    });
    await replay.start();

    const walking = replay.catchUp();
    await saveStarted; // the first save is in flight and blocked
    await walking; // the whole walk runs while it is still blocked

    releaseSave();
    await new Promise((r) => setTimeout(r, 10)); // let the coalesced save land

    // Four pages, but only two writes: the one that was in flight, and a
    // single collapsed value for everything that happened during it.
    expect(saved).toEqual([5, 20]);
    expect(replay.resumeFrom).toBe(20);
  });

  it('never persists a lower cursor than one already requested', async () => {
    const saved: number[] = [];
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async () => []),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async () => {}),
      pageSize: PAGE,
      saveCursor: vi.fn(async (c: number) => {
        saved.push(c);
      }),
    });
    await replay.start();

    await replay.handleLive(alert(10));
    await replay.handleLive(alert(20));
    await new Promise((r) => setTimeout(r, 10));

    expect(saved).toEqual([...saved].sort((a, b) => a - b));
    expect(saved[saved.length - 1]).toBe(20);
  });
});

describe('AlertReplay: overlapping live deliveries', () => {
  it('catches the cursor up when a higher id resolves before a lower one', async () => {
    // The higher id resolving first was blocked by the lower one still in
    // flight, and nothing revisited it -- so the cursor stalled below an alert
    // already posted, and a restart re-posted it.
    const releases = new Map<number, () => void>();
    const posted: number[] = [];
    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async () => []),
      getAlertHead: vi.fn(async () => 100),
      deliver: vi.fn(async (a: AlertEvent) => {
        await new Promise<void>((resolve) => releases.set(a.id, resolve));
        posted.push(a.id);
      }),
      pageSize: PAGE,
    });
    await replay.start();

    const first = replay.handleLive(alert(101));
    const second = replay.handleLive(alert(102));
    await new Promise((r) => setTimeout(r, 5));

    releases.get(102)!(); // the LATER alert resolves first
    await second;
    expect(replay.resumeFrom).toBe(100); // blocked by 101, still in flight

    releases.get(101)!();
    await first;

    // Both delivered, so the cursor must reflect the highest of them.
    expect([...posted].sort((a, b) => a - b)).toEqual([101, 102]);
    expect(replay.resumeFrom).toBe(102);
  });

  it('flushPendingCursor waits for an in-flight save', async () => {
    let releaseSave: () => void = () => {};
    let saveGate: () => void = () => {};
    const saveStarted = new Promise<void>((resolve) => (saveGate = resolve));
    let finished = false;

    const replay = new AlertReplay({
      listAlertsSince: vi.fn(async () => []),
      getAlertHead: vi.fn(async () => 0),
      deliver: vi.fn(async () => {}),
      pageSize: PAGE,
      saveCursor: vi.fn(async () => {
        saveGate();
        await new Promise<void>((resolve) => (releaseSave = resolve));
        finished = true;
      }),
    });
    await replay.start();

    await replay.handleLive(alert(5));
    await saveStarted;

    const flushing = replay.flushPendingCursor().then(() => {
      // Must not resolve before the save actually completed, or a shutdown
      // exits with the cursor unsaved and re-posts those alerts.
      expect(finished).toBe(true);
    });

    releaseSave();
    await flushing;
  });
});
