// testimonials.ts — member stories captured at the payout moment.
//
// Spec: marketing/handoff/inbox/003-founder-moments-spec/SPEC.md §3.
//
// Rules this module enforces, not just documents:
//  * A story is stored only with an explicit consent flag; the API refuses
//    submissions where consent_marketing is not true.
//  * Nothing is "usable" until a human sets status = 'approved' in
//    /admin/testimonials. 'withdrawn' removes a story from every queue.
//  * Identity is the server-verified session address; this module never
//    trusts a caller-supplied address for writes.
//  * No photos in v1: there is no consented, revocable photo store yet
//    (Walrus blobs are public and immutable — wrong tool for a face).

import { getSharedPgPool } from './pg-pool';

export const TESTIMONIAL_STATUSES = ['pending', 'approved', 'used', 'withdrawn'] as const;
export type TestimonialStatus = (typeof TESTIMONIAL_STATUSES)[number];

export const QUOTE_MIN_CHARS = 12;
export const QUOTE_MAX_CHARS = 600;

export interface Testimonial {
  id: number;
  userAddress: string;
  circleId: string;
  quote: string;
  consentMarketing: boolean;
  consentAtMs: number | null;
  status: TestimonialStatus;
  createdAtMs: number;
  reviewedAtMs: number | null;
}

let setupPromise: Promise<void> | null = null;

/** Lazy self-creation race guard, mirroring the other registries. */
function ensureTable(): Promise<void> {
  if (!setupPromise) {
    setupPromise = getSharedPgPool()
      .query(
        `CREATE TABLE IF NOT EXISTS circle_testimonials (
           id                BIGSERIAL PRIMARY KEY,
           user_address      TEXT NOT NULL,
           circle_id         TEXT NOT NULL,
           quote             TEXT NOT NULL,
           consent_marketing BOOLEAN NOT NULL DEFAULT FALSE,
           consent_at        TIMESTAMPTZ,
           status            TEXT NOT NULL DEFAULT 'pending',
           created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
           reviewed_at       TIMESTAMPTZ
         );
         CREATE INDEX IF NOT EXISTS circle_testimonials_status_idx
           ON circle_testimonials (status, created_at DESC);
         CREATE INDEX IF NOT EXISTS circle_testimonials_address_idx
           ON circle_testimonials (user_address);`,
      )
      .then(() => undefined)
      .catch((err) => {
        setupPromise = null;
        throw err;
      });
  }
  return setupPromise;
}

interface Row {
  id: string | number;
  user_address: string;
  circle_id: string;
  quote: string;
  consent_marketing: boolean;
  consent_at: Date | null;
  status: string;
  created_at: Date;
  reviewed_at: Date | null;
}

function toTestimonial(r: Row): Testimonial {
  return {
    id: Number(r.id),
    userAddress: r.user_address,
    circleId: r.circle_id,
    quote: r.quote,
    consentMarketing: r.consent_marketing,
    consentAtMs: r.consent_at ? r.consent_at.getTime() : null,
    status: (TESTIMONIAL_STATUSES as readonly string[]).includes(r.status)
      ? (r.status as TestimonialStatus)
      : 'pending',
    createdAtMs: r.created_at.getTime(),
    reviewedAtMs: r.reviewed_at ? r.reviewed_at.getTime() : null,
  };
}

/** Normalises a quote: trims, collapses whitespace runs, strips control chars. */
export function normaliseQuote(raw: string): string {
  return raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function createTestimonial(input: {
  userAddress: string;
  circleId: string;
  quote: string;
  consentMarketing: boolean;
}): Promise<Testimonial> {
  if (!input.consentMarketing) {
    // Belt and braces: the API already refuses this, but the store must not
    // be able to hold a story the member did not explicitly consent to.
    throw new Error('CONSENT_REQUIRED');
  }
  const quote = normaliseQuote(input.quote);
  if (quote.length < QUOTE_MIN_CHARS || quote.length > QUOTE_MAX_CHARS) {
    throw new Error('QUOTE_LENGTH');
  }
  await ensureTable();
  const { rows } = await getSharedPgPool().query<Row>(
    `INSERT INTO circle_testimonials
       (user_address, circle_id, quote, consent_marketing, consent_at, status)
     VALUES ($1, $2, $3, TRUE, NOW(), 'pending')
     RETURNING *`,
    [input.userAddress.toLowerCase(), input.circleId, quote],
  );
  return toTestimonial(rows[0]);
}

export async function listTestimonials(
  status: TestimonialStatus,
  limit = 100,
): Promise<Testimonial[]> {
  await ensureTable();
  const { rows } = await getSharedPgPool().query<Row>(
    `SELECT * FROM circle_testimonials
      WHERE status = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [status, Math.max(1, Math.min(500, limit))],
  );
  return rows.map(toTestimonial);
}

/** Operator review transition. 'withdrawn' is also reachable by the member (see withdrawOwn). */
export async function setTestimonialStatus(
  id: number,
  status: TestimonialStatus,
): Promise<Testimonial | null> {
  await ensureTable();
  const { rows } = await getSharedPgPool().query<Row>(
    `UPDATE circle_testimonials
        SET status = $2, reviewed_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, status],
  );
  return rows[0] ? toTestimonial(rows[0]) : null;
}

/** A member may withdraw their own story at any time; it leaves every queue. */
export async function withdrawOwnTestimonial(
  id: number,
  userAddress: string,
): Promise<boolean> {
  await ensureTable();
  const { rowCount } = await getSharedPgPool().query(
    `UPDATE circle_testimonials
        SET status = 'withdrawn', reviewed_at = NOW()
      WHERE id = $1 AND user_address = $2 AND status <> 'withdrawn'`,
    [id, userAddress.toLowerCase()],
  );
  return (rowCount ?? 0) > 0;
}

export async function listOwnTestimonials(userAddress: string): Promise<Testimonial[]> {
  await ensureTable();
  const { rows } = await getSharedPgPool().query<Row>(
    `SELECT * FROM circle_testimonials
      WHERE user_address = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    [userAddress.toLowerCase()],
  );
  return rows.map(toTestimonial);
}
