/**
 * milestone-entitlement-preflight.test.ts — Pins the CLIENT-SAFE mirror
 * of entitlement-gate's browser preflight
 * (src/components/milestones/entitlement-preflight.ts):
 *
 * - Kill switch off (NEXT_PUBLIC_BILLING_ENABLED unset/false): every
 *   feature check passes WITHOUT hitting /api/billing/status.
 * - Billing on: premium plan → entitled; free plan / non-OK response /
 *   thrown fetch → NOT entitled (the UI errs toward showing the upsell,
 *   never toward hiding the gate).
 * - Server-side kill switch (`data.billingEnabled === false`) passes.
 * - The mirror must not (transitively) import stripe-service / pg-pool —
 *   that is the entire reason it exists: value-importing the real gate
 *   from client code drags the Stripe SDK + pg pool into the browser
 *   bundle and breaks `next build`.
 *
 * The module reads NEXT_PUBLIC_BILLING_ENABLED at import time (so Next
 * can inline it into the client bundle), hence jest.isolateModules with
 * the env var set before each require.
 */

type PreflightModule =
  typeof import('@/components/milestones/entitlement-preflight');

const ORIGINAL_FLAG = process.env.NEXT_PUBLIC_BILLING_ENABLED;

function loadPreflight(billingEnabled: boolean): PreflightModule {
  if (billingEnabled) {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = 'true';
  } else {
    delete process.env.NEXT_PUBLIC_BILLING_ENABLED;
  }
  let mod: PreflightModule | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('@/components/milestones/entitlement-preflight');
  });
  if (!mod) throw new Error('failed to load entitlement-preflight');
  return mod;
}

function mockBillingStatus(response: {
  ok?: boolean;
  status?: number;
  body?: unknown;
}): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.body ?? {},
  });
  (global as { fetch?: unknown }).fetch = fetchMock;
  return fetchMock;
}

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) {
    delete process.env.NEXT_PUBLIC_BILLING_ENABLED;
  } else {
    process.env.NEXT_PUBLIC_BILLING_ENABLED = ORIGINAL_FLAG;
  }
  delete (global as { fetch?: unknown }).fetch;
});

describe('hasFeaturePreflight (client-safe mirror)', () => {
  it('passes every feature without fetching while billing is disabled', async () => {
    const fetchMock = mockBillingStatus({});
    const { hasFeaturePreflight } = loadPreflight(false);

    await expect(hasFeaturePreflight('smartGoals')).resolves.toBe(true);
    await expect(hasFeaturePreflight('whatsappSuite')).resolves.toBe(true);
    await expect(hasFeaturePreflight('analytics')).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('entitles premium plans via GET /api/billing/status', async () => {
    const fetchMock = mockBillingStatus({
      body: { success: true, data: { plan: 'premium' } },
    });
    const { hasFeaturePreflight } = loadPreflight(true);

    await expect(hasFeaturePreflight('smartGoals')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/billing/status',
      expect.objectContaining({
        method: 'GET',
        credentials: 'same-origin',
      }),
    );
  });

  it('does not entitle the free plan', async () => {
    mockBillingStatus({ body: { success: true, data: { plan: 'free' } } });
    const { hasFeaturePreflight } = loadPreflight(true);
    await expect(hasFeaturePreflight('smartGoals')).resolves.toBe(false);
  });

  it('passes when the server reports billing disabled', async () => {
    mockBillingStatus({
      body: { success: true, data: { plan: 'free', billingEnabled: false } },
    });
    const { hasFeaturePreflight } = loadPreflight(true);
    await expect(hasFeaturePreflight('smartGoals')).resolves.toBe(true);
  });

  it('resolves false on a non-OK response (errs toward the upsell)', async () => {
    mockBillingStatus({ ok: false, status: 500 });
    const { hasFeaturePreflight } = loadPreflight(true);
    await expect(hasFeaturePreflight('smartGoals')).resolves.toBe(false);
  });

  it('resolves false when the fetch throws', async () => {
    (global as { fetch?: unknown }).fetch = jest
      .fn()
      .mockRejectedValue(new Error('network down'));
    const { hasFeaturePreflight } = loadPreflight(true);
    await expect(hasFeaturePreflight('smartGoals')).resolves.toBe(false);
  });

  it('only ever type-imports from the server-only entitlement gate', () => {
    // The mirror exists because value-importing entitlement-gate.ts from
    // client code drags the Stripe SDK + pg pool into the browser bundle
    // and breaks `next build`. Type-only imports are erased at compile
    // time, so they are the ONLY acceptable reference. Source-level
    // check: every import that mentions the gate (or the billing stack)
    // must be an `import type`.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path') as typeof import('path');
    const source = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        '..',
        'components',
        'milestones',
        'entitlement-preflight.ts',
      ),
      'utf8',
    );
    const importStatements =
      source.match(/^import[\s\S]*?from\s+['"][^'"]+['"];?$/gm) ?? [];
    const billingImports = importStatements.filter((statement) =>
      /entitlement-gate|stripe-service|pg-pool/.test(statement),
    );
    expect(billingImports.length).toBeGreaterThan(0);
    for (const statement of billingImports) {
      expect(statement.startsWith('import type')).toBe(true);
    }
  });
});
