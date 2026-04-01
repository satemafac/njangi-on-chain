import {
  autoReleaseDelayMsToDays,
  daysToAutoReleaseDelayMs,
  formatAutoReleaseDurationDays,
  getDefaultAutoReleaseDelayMs,
  getMinimumAutoReleaseDelayMs,
  getMinimumAutoReleaseDelayMsForMoveCycleLength,
  isValidAutoReleaseDelayMs,
} from '@/lib/auto-release';

describe('auto-release helpers', () => {
  it('matches Move minimum delay rules for each cycle length', () => {
    expect(getMinimumAutoReleaseDelayMs('weekly')).toBe(daysToAutoReleaseDelayMs(7));
    expect(getMinimumAutoReleaseDelayMs('bi-weekly')).toBe(daysToAutoReleaseDelayMs(14));
    expect(getMinimumAutoReleaseDelayMs('monthly')).toBe(daysToAutoReleaseDelayMs(30));
    expect(getMinimumAutoReleaseDelayMs('quarterly')).toBe(daysToAutoReleaseDelayMs(90));
    expect(getMinimumAutoReleaseDelayMsForMoveCycleLength(0)).toBe(daysToAutoReleaseDelayMs(7));
    expect(getMinimumAutoReleaseDelayMsForMoveCycleLength(3)).toBe(daysToAutoReleaseDelayMs(14));
    expect(getMinimumAutoReleaseDelayMsForMoveCycleLength(99)).toBeNull();
  });

  it('returns a default delay that is always valid', () => {
    expect(isValidAutoReleaseDelayMs('weekly', getDefaultAutoReleaseDelayMs('weekly'))).toBe(true);
    expect(isValidAutoReleaseDelayMs('monthly', getDefaultAutoReleaseDelayMs('monthly'))).toBe(true);
    expect(isValidAutoReleaseDelayMs('quarterly', getDefaultAutoReleaseDelayMs('quarterly'))).toBe(true);
  });

  it('rejects delays that are equal to or below the cycle duration', () => {
    expect(isValidAutoReleaseDelayMs('weekly', daysToAutoReleaseDelayMs(7))).toBe(false);
    expect(isValidAutoReleaseDelayMs('weekly', daysToAutoReleaseDelayMs(6))).toBe(false);
    expect(isValidAutoReleaseDelayMs('monthly', daysToAutoReleaseDelayMs(30))).toBe(false);
  });

  it('converts delay values to whole-day UI units', () => {
    expect(autoReleaseDelayMsToDays(daysToAutoReleaseDelayMs(8))).toBe(8);
    expect(formatAutoReleaseDurationDays(1)).toBe('1 day');
    expect(formatAutoReleaseDurationDays(45)).toBe('45 days');
  });
});
