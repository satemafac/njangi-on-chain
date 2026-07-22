import {
  DEFAULT_PROBE_LOOKBACK_MS,
  isHourlyFullPassTick,
  probeForRecentEvents,
} from '@/lib/cron-event-probe';

const NOW = 1_800_000_000_000;

function clientWithNewest(timestampMs: number | null | undefined) {
  return {
    queryEvents: jest.fn(async () => ({
      data: timestampMs === undefined ? [] : [{ timestampMs }],
      nextCursor: null,
      hasNextPage: false,
    })),
  };
}

describe('probeForRecentEvents', () => {
  it('runs the full pass when the newest event is inside the lookback', async () => {
    const client = clientWithNewest(NOW - 60_000);
    const result = await probeForRecentEvents({
      client: client as never,
      eventType: '0x1::m::E',
      now: NOW,
    });
    expect(result).toEqual({
      runFullPass: true,
      reason: 'recent_event',
      newestEventMs: NOW - 60_000,
    });
    // Probe must be a single cheap descending-limit-1 read.
    expect(client.queryEvents).toHaveBeenCalledWith({
      query: { MoveEventType: '0x1::m::E' },
      limit: 1,
      order: 'descending',
    });
  });

  it('skips (no DB touch) when the newest event is older than the lookback', async () => {
    const stale = NOW - DEFAULT_PROBE_LOOKBACK_MS - 1;
    const result = await probeForRecentEvents({
      client: clientWithNewest(stale) as never,
      eventType: '0x1::m::E',
      now: NOW,
    });
    expect(result.runFullPass).toBe(false);
    expect(result.reason).toBe('no_recent_events');
  });

  it('skips when the stream has no events at all', async () => {
    const result = await probeForRecentEvents({
      client: clientWithNewest(undefined) as never,
      eventType: '0x1::m::E',
      now: NOW,
    });
    expect(result).toEqual({
      runFullPass: false,
      reason: 'no_recent_events',
      newestEventMs: null,
    });
  });

  it('treats a missing timestamp as not-recent rather than crashing', async () => {
    const result = await probeForRecentEvents({
      client: clientWithNewest(null) as never,
      eventType: '0x1::m::E',
      now: NOW,
    });
    expect(result.runFullPass).toBe(false);
  });

  it('bypasses the probe entirely when a full pass is forced', async () => {
    const client = clientWithNewest(undefined);
    const result = await probeForRecentEvents({
      client: client as never,
      eventType: '0x1::m::E',
      forceFullPass: true,
      now: NOW,
    });
    expect(result.reason).toBe('forced_full_pass');
    expect(result.runFullPass).toBe(true);
    expect(client.queryEvents).not.toHaveBeenCalled();
  });

  it('fails toward correctness: a probe error runs the full pass', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const client = {
      queryEvents: jest.fn(async () => {
        throw new Error('rpc down');
      }),
    };
    const result = await probeForRecentEvents({
      client: client as never,
      eventType: '0x1::m::E',
      now: NOW,
    });
    expect(result.runFullPass).toBe(true);
    expect(result.reason).toBe('probe_failed');
    warnSpy.mockRestore();
  });
});

describe('isHourlyFullPassTick', () => {
  it('is true only for the first quarter-hour tick', () => {
    expect(isHourlyFullPassTick(new Date('2026-07-21T10:00:30Z'))).toBe(true);
    expect(isHourlyFullPassTick(new Date('2026-07-21T10:14:59Z'))).toBe(true);
    expect(isHourlyFullPassTick(new Date('2026-07-21T10:15:00Z'))).toBe(false);
    expect(isHourlyFullPassTick(new Date('2026-07-21T10:45:00Z'))).toBe(false);
  });
});
