// funnel-events.ts — the four activation events the beta strategy wants to
// measure (docs/product-strategy-beta-2026-08.md §12: "organizer completes
// setup in one session"). Vercel Analytics is already mounted in _app.tsx
// for page views; these are the custom events that turn "too many clicks"
// from an anecdote into a number.
//
// No properties that identify a person: no addresses, names, emails. The
// event name is the whole payload unless a caller passes a coarse count.

import { track } from '@vercel/analytics';

export type FunnelEvent =
  | 'signin_completed'
  | 'legal_accepted'
  | 'circle_created'
  | 'invite_link_copied'
  | 'invite_link_shared';

export function trackFunnel(
  event: FunnelEvent,
  properties?: Record<string, string | number | boolean>,
): void {
  if (typeof window === 'undefined') return;
  try {
    track(event, properties);
  } catch {
    // Analytics must never break the funnel it measures.
  }
}
