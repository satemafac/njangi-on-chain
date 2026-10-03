// chain-clock.ts — "now", as the chain sees it.
//
// Deadlines the contract enforces (the 30-day claim window, the 7-day cancel
// grace) are judged against the `0x2::clock::Clock` a transaction reads, not
// against the device's clock. A UI that decided them on `Date.now()` could
// announce a window as closed, and offer the refund that ends it, because a
// phone's clock ran a day fast. The shared Clock object carries the chain's
// own timestamp, current to within a checkpoint, and reading it is one
// object read that every endpoint serves.

import type { SuiClient } from '@mysten/sui/client';

export const SUI_CLOCK_OBJECT_ID = '0x6';

/**
 * The chain's current time in ms, or null when it could not be read. Null is
 * "unknown": callers must never treat it as a time on either side of a
 * deadline.
 */
export async function readChainClockMs(client: SuiClient): Promise<number | null> {
  try {
    const obj = await client.getObject({ id: SUI_CLOCK_OBJECT_ID, options: { showContent: true } });
    const content = obj.data?.content;
    if (!content || content.dataType !== 'moveObject') return null;
    const raw = (content.fields as Record<string, unknown>).timestamp_ms;
    const ms =
      typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : typeof raw === 'number' ? raw : NaN;
    return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
  } catch (err) {
    console.warn('[chain-clock] could not read the chain clock', err);
    return null;
  }
}
