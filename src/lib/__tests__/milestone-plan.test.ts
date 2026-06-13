// Tests for the smart-goal milestone plan model: sketch + publish
// validation (mirroring njangi_milestones.move's abort conditions),
// exact display-amount parsing, the friendly abort-code mapping, and the
// create-circle → goals-page pending-plan hand-off.

import {
  MAX_DESCRIPTION_BYTES,
  MAX_MILESTONES,
  clearPendingMilestonePlan,
  descriptionByteLength,
  explainMilestoneError,
  formatBaseAmount,
  loadPendingMilestonePlan,
  parseDisplayAmountToBase,
  savePendingMilestonePlan,
  validatePlanSketch,
  validatePublishPlan,
  type MilestoneDraft,
} from '@/components/milestones/milestone-plan';

const NOW = 1_750_000_000_000;

function monetarySketch(targetUsd: number, description = 'Save together'): MilestoneDraft {
  return { kind: 'monetary', description, targetUsd, requiresVerification: false };
}

function timeSketch(targetTimestampMs: number, description = 'Keep going'): MilestoneDraft {
  return { kind: 'time', description, targetTimestampMs, requiresVerification: false };
}

function monetaryPublish(base: string, description = 'Save together'): MilestoneDraft {
  return {
    kind: 'monetary',
    description,
    targetAmountBase: base,
    requiresVerification: false,
  };
}

describe('validatePlanSketch', () => {
  it('accepts an increasing mixed plan', () => {
    const plan = [
      monetarySketch(500),
      timeSketch(NOW + 86_400_000),
      monetarySketch(1000),
      timeSketch(NOW + 2 * 86_400_000),
    ];
    expect(validatePlanSketch(plan, { nowMs: NOW })).toEqual([]);
  });

  it('rejects empty descriptions', () => {
    const errors = validatePlanSketch([monetarySketch(500, '   ')], { nowMs: NOW });
    expect(errors.some((e) => e.includes('description'))).toBe(true);
  });

  it('rejects descriptions over the on-chain byte cap (multi-byte aware)', () => {
    // 'é' is 2 bytes in UTF-8 — 200 chars stays under the char count but
    // crosses 256 bytes, exactly what E_DESCRIPTION_TOO_LONG would catch.
    const description = 'é'.repeat(200);
    expect(descriptionByteLength(description)).toBeGreaterThan(MAX_DESCRIPTION_BYTES);
    const errors = validatePlanSketch([monetarySketch(500, description)], { nowMs: NOW });
    expect(errors.some((e) => e.includes('too long'))).toBe(true);
  });

  it('rejects zero and non-increasing monetary targets (E_TARGET_NOT_INCREASING)', () => {
    expect(
      validatePlanSketch([monetarySketch(0)], { nowMs: NOW }).length,
    ).toBeGreaterThan(0);
    const errors = validatePlanSketch(
      [monetarySketch(500), monetarySketch(500)],
      { nowMs: NOW },
    );
    expect(errors.some((e) => e.includes('aim higher'))).toBe(true);
  });

  it('rejects past and non-increasing time targets (E_TARGET_INVALID / NOT_INCREASING)', () => {
    expect(
      validatePlanSketch([timeSketch(NOW - 1)], { nowMs: NOW }).length,
    ).toBeGreaterThan(0);
    const errors = validatePlanSketch(
      [timeSketch(NOW + 1000), timeSketch(NOW + 1000)],
      { nowMs: NOW },
    );
    expect(errors.some((e) => e.includes('after the previous'))).toBe(true);
  });

  it('validates monetary and time monotonicity independently (mirrors last_target_of_kind)', () => {
    // A large monetary target between two time targets must not affect
    // the time ordering, and vice versa.
    const plan = [
      timeSketch(NOW + 86_400_000),
      monetarySketch(10_000),
      timeSketch(NOW + 2 * 86_400_000),
      monetarySketch(20_000),
    ];
    expect(validatePlanSketch(plan, { nowMs: NOW })).toEqual([]);
  });

  it('rejects plans over the 32-milestone cap (E_TOO_MANY_MILESTONES)', () => {
    const plan = Array.from({ length: MAX_MILESTONES + 1 }, (_, i) =>
      monetarySketch((i + 1) * 100),
    );
    const errors = validatePlanSketch(plan, { nowMs: NOW });
    expect(errors.some((e) => e.includes(`${MAX_MILESTONES}`))).toBe(true);
  });
});

describe('validatePublishPlan', () => {
  const baseCtx = {
    nowMs: NOW,
    monetaryFloorBase: 0n,
    timeFloorMs: 0,
    existingOnChainCount: 0,
  };

  it('accepts a strictly-increasing publish plan', () => {
    const plan = [monetaryPublish('1000000000'), monetaryPublish('2000000000')];
    expect(validatePublishPlan(plan, baseCtx)).toEqual([]);
  });

  it('rejects an empty plan', () => {
    expect(validatePublishPlan([], baseCtx).length).toBeGreaterThan(0);
  });

  it('enforces the floor set by milestones already on chain', () => {
    const plan = [monetaryPublish('1000000000')];
    const errors = validatePublishPlan(plan, {
      ...baseCtx,
      monetaryFloorBase: 1_000_000_000n, // equal — must strictly exceed
    });
    expect(errors.some((e) => e.includes('aim higher'))).toBe(true);
  });

  it('enforces the time floor from on-chain milestones', () => {
    const plan = [
      { kind: 'time', description: 'd', targetTimestampMs: NOW + 1000, requiresVerification: false } as MilestoneDraft,
    ];
    const errors = validatePublishPlan(plan, { ...baseCtx, timeFloorMs: NOW + 1000 });
    expect(errors.some((e) => e.includes('after the previous'))).toBe(true);
  });

  it('counts on-chain milestones toward the 32-milestone cap', () => {
    const plan = [monetaryPublish('1000000000')];
    const errors = validatePublishPlan(plan, {
      ...baseCtx,
      existingOnChainCount: MAX_MILESTONES,
    });
    expect(errors.some((e) => e.includes(`${MAX_MILESTONES}`))).toBe(true);
  });

  it('rejects unparseable or zero base targets', () => {
    const errors = validatePublishPlan([monetaryPublish('not-a-number')], baseCtx);
    expect(errors.some((e) => e.includes('greater than zero'))).toBe(true);
  });
});

describe('parseDisplayAmountToBase', () => {
  it('parses whole and fractional amounts exactly', () => {
    expect(parseDisplayAmountToBase('1.5', 9)).toBe(1_500_000_000n);
    expect(parseDisplayAmountToBase('10', 6)).toBe(10_000_000n);
    expect(parseDisplayAmountToBase('0.000001', 6)).toBe(1n);
  });

  it('avoids float artifacts on awkward decimals', () => {
    // 0.1 + 0.2 style values: exact string parsing, no rounding error.
    expect(parseDisplayAmountToBase('0.3', 9)).toBe(300_000_000n);
    expect(parseDisplayAmountToBase('123456789.123456789', 9)).toBe(
      123_456_789_123_456_789n,
    );
  });

  it('rejects more fractional digits than the coin supports', () => {
    expect(parseDisplayAmountToBase('1.1234567', 6)).toBeNull();
  });

  it('rejects junk, negatives, and empty input', () => {
    expect(parseDisplayAmountToBase('', 9)).toBeNull();
    expect(parseDisplayAmountToBase('abc', 9)).toBeNull();
    expect(parseDisplayAmountToBase('-5', 9)).toBeNull();
    expect(parseDisplayAmountToBase('1,000', 9)).toBeNull();
  });
});

describe('formatBaseAmount', () => {
  it('round-trips with the parser', () => {
    expect(formatBaseAmount('2000000000', 9)).toBe('2');
    expect(formatBaseAmount('2500000000', 9)).toBe('2.5');
    expect(formatBaseAmount(1n, 6)).toBe('0.000001');
  });
});

describe('explainMilestoneError', () => {
  const abort = (code: number) =>
    new Error(
      `MoveAbort(MoveLocation { module: ModuleId { address: 89cddf4d, name: Identifier("njangi_milestones") }, ` +
        `function: 3, instruction: 22, function_name: Some("add_monetary_milestone") }, ${code}) in command 0`,
    );

  it('maps njangi_milestones abort codes to friendly sentences', () => {
    expect(explainMilestoneError(abort(406))).toContain('bigger than the one before');
    expect(explainMilestoneError(abort(409))).toContain('already been counted');
    expect(explainMilestoneError(abort(412))).toContain('admin needs to confirm');
  });

  it('passes through unknown codes and unrelated errors', () => {
    const unknown = abort(999);
    expect(explainMilestoneError(unknown)).toBe(unknown.message);
    const other = new Error('Insufficient gas');
    expect(explainMilestoneError(other)).toBe('Insufficient gas');
  });
});

describe('pending milestone plan persistence', () => {
  const store = new Map<string, string>();

  beforeAll(() => {
    (globalThis as Record<string, unknown>).window = {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    };
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  beforeEach(() => store.clear());

  it('saves and loads a plan per admin address (case-insensitive)', () => {
    savePendingMilestonePlan({
      adminAddress: '0xA11CE',
      circleName: 'Village Savings',
      savedAtMs: NOW,
      entries: [monetarySketch(500)],
    });
    const loaded = loadPendingMilestonePlan('0xa11ce');
    expect(loaded?.circleName).toBe('Village Savings');
    expect(loaded?.entries).toHaveLength(1);
    expect(loaded?.entries[0].targetUsd).toBe(500);
  });

  it('returns null for unknown addresses and after clearing', () => {
    expect(loadPendingMilestonePlan('0xnobody')).toBeNull();
    savePendingMilestonePlan({
      adminAddress: '0xa11ce',
      circleName: 'x',
      savedAtMs: NOW,
      entries: [monetarySketch(1)],
    });
    clearPendingMilestonePlan('0xA11CE');
    expect(loadPendingMilestonePlan('0xa11ce')).toBeNull();
  });

  it('survives corrupted storage gracefully', () => {
    store.set('njangi.milestones.pendingPlan.0xbad', '{not json');
    expect(loadPendingMilestonePlan('0xbad')).toBeNull();
  });
});
