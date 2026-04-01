export type AutoReleaseCycleLength = 'weekly' | 'bi-weekly' | 'monthly' | 'quarterly';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const MIN_DELAY_BY_CYCLE_LENGTH: Record<AutoReleaseCycleLength, number> = {
  weekly: 7 * MS_PER_DAY,
  'bi-weekly': 14 * MS_PER_DAY,
  monthly: 30 * MS_PER_DAY,
  quarterly: 90 * MS_PER_DAY,
};

const MOVE_CYCLE_LENGTH_TO_UI_CYCLE_LENGTH: Record<number, AutoReleaseCycleLength> = {
  0: 'weekly',
  1: 'monthly',
  2: 'quarterly',
  3: 'bi-weekly',
};

export const getMinimumAutoReleaseDelayMs = (cycleLength: AutoReleaseCycleLength): number =>
  MIN_DELAY_BY_CYCLE_LENGTH[cycleLength];

export const getMinimumAutoReleaseDelayMsForMoveCycleLength = (
  cycleLength: number,
): number | null => {
  const mappedCycleLength = MOVE_CYCLE_LENGTH_TO_UI_CYCLE_LENGTH[cycleLength];
  return mappedCycleLength ? getMinimumAutoReleaseDelayMs(mappedCycleLength) : null;
};

export const getDefaultAutoReleaseDelayMs = (cycleLength: AutoReleaseCycleLength): number =>
  getMinimumAutoReleaseDelayMs(cycleLength) + MS_PER_DAY;

export const isValidAutoReleaseDelayMs = (
  cycleLength: AutoReleaseCycleLength,
  autoReleaseDelayMs: number,
): boolean => autoReleaseDelayMs > getMinimumAutoReleaseDelayMs(cycleLength);

export const daysToAutoReleaseDelayMs = (days: number): number =>
  Math.max(0, Math.trunc(days)) * MS_PER_DAY;

export const autoReleaseDelayMsToDays = (delayMs: number): number =>
  Math.max(0, Math.round(delayMs / MS_PER_DAY));

export const formatAutoReleaseDurationDays = (days: number): string =>
  `${days} day${days === 1 ? '' : 's'}`;
