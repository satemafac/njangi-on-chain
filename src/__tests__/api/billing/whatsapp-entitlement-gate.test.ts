/**
 * WhatsApp suite entitlement gate on POST /api/whatsapp/admin-link-circle.
 *
 * The WhatsApp suite is the genuinely ENFORCEABLE premium feature (server
 * holds the Walrus PII keys and anchors the link on chain), so the gate
 * lives in the API route after admin auth and before any side effect:
 *
 * - Billing disabled (default): linking works for everyone, no 402.
 * - Billing enabled + no subscription: 402 with the typed
 *   {code:'UPGRADE_REQUIRED', feature:'whatsappSuite'} body, and ZERO side
 *   effects (no Walrus upload, no chain anchor, no index write).
 * - Billing enabled + premium subscription: linking proceeds.
 *
 * Uses the real entitlement-gate + stripe-service in-memory store (pg-pool
 * mocked unconfigured) so the gate is exercised end-to-end through the
 * route, with the same middleware/session setup as the admin auth tests.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

jest.mock('@/lib/pg-pool', () => ({
  getSharedPgPool: jest.fn(),
  isPostgresConfigured: jest.fn(() => false),
}));
jest.mock('@/services/whatsapp-registry-service', () => ({
  getActiveWhatsAppRegistries: jest.fn(),
}));
jest.mock('@/services/network-config', () => ({
  getNetworkConfig: jest.fn(() => ({ rpcUrl: 'http://localhost:9000' })),
}));
jest.mock('@/services/sui-rpc-failover', () => ({
  getPooledSuiClient: jest.fn(),
}));
jest.mock('@/services/enokiZkLoginService', () => ({
  enokiZkLoginService: { sendTransaction: jest.fn() },
}));
jest.mock('@/lib/walrus-pii', () => ({
  encryptAndStorePII: jest.fn(),
  fetchAndDecryptPII: jest.fn(),
  nonceToHex: jest.fn(() => 'deadbeef'),
}));
jest.mock('@/lib/whatsapp-link-index', () => ({
  indexWhatsAppLink: jest.fn(),
}));
jest.mock('@/lib/circle-admin-verification', () => {
  const actual = jest.requireActual('@/lib/circle-admin-verification');
  return {
    ...actual,
    fetchCircleAdminAddress: jest.fn(),
  };
});

import handler from '@/pages/api/whatsapp/admin-link-circle';
import { getZkLoginSessionStore } from '@/lib/zklogin-session-registry';
import type { ZkLoginSessionRecord } from '@/lib/zklogin-session-registry';
import { fetchCircleAdminAddress } from '@/lib/circle-admin-verification';
import { getActiveWhatsAppRegistries } from '@/services/whatsapp-registry-service';
import { enokiZkLoginService } from '@/services/enokiZkLoginService';
import { encryptAndStorePII } from '@/lib/walrus-pii';
import { indexWhatsAppLink } from '@/lib/whatsapp-link-index';
import {
  __resetStripeServiceForTests,
  applySubscriptionState,
  upsertSubscriptionIdentity,
} from '@/services/stripe-service';

const ADMIN_ADDRESS = '0x' + 'a1'.repeat(32);
const CIRCLE_ID = '0x' + 'c3'.repeat(32);
const SESSION_ID = 'whatsapp-gate-session';
const PHONE = '+237650000000';

const ORIGINAL_FLAG = process.env.NEXT_PUBLIC_BILLING_ENABLED;

function setBillingEnabled(enabled: boolean): void {
  process.env.NEXT_PUBLIC_BILLING_ENABLED = enabled ? 'true' : 'false';
}

function buildSessionRecord(userAddr: string): ZkLoginSessionRecord {
  return {
    provider: 'Google',
    maxEpoch: 100,
    randomness: 'rand',
    ephemeralPrivateKey: 'ephemeral-key',
    account: {
      provider: 'Google',
      userAddr,
      zkProofs: {
        proofPoints: { a: ['1'], b: [['2']], c: ['3'] },
        issBase64Details: { value: 'iss', indexMod4: 0 },
        headerBase64: 'header',
      },
      ephemeralPrivateKey: 'ephemeral-key',
      userSalt: '42',
      sub: 'sub',
      aud: 'aud',
      maxEpoch: 100,
    },
  };
}

interface MockRes {
  statusCode: number;
  jsonBody: unknown;
}

function createMockRes(): NextApiResponse & MockRes {
  const res = {
    statusCode: 0,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  return res as unknown as NextApiResponse & MockRes;
}

function createLinkReq(): NextApiRequest {
  return {
    method: 'POST',
    url: '/api/whatsapp/admin-link-circle',
    headers: {},
    socket: {},
    cookies: { 'session-id': SESSION_ID },
    query: {},
    body: {
      circleId: CIRCLE_ID,
      linkType: 1,
      phoneOrGroup: PHONE,
      network: 'testnet',
      // No `account` payload: the route stores the encrypted PII and
      // returns the pending-anchor response, which keeps this test off the
      // chain path while still crossing the gate + Walrus side effect.
    },
  } as unknown as NextApiRequest;
}

async function seedPremiumSubscriptionForAdmin(): Promise<void> {
  await upsertSubscriptionIdentity(
    { sub: 'sub', aud: 'aud', userAddress: ADMIN_ADDRESS },
    'cus_admin',
  );
  await applySubscriptionState({
    stripeCustomerId: 'cus_admin',
    stripeSubscriptionId: 'sub_admin',
    priceId: 'price_premium',
    status: 'active',
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: false,
  });
}

describe('admin-link-circle POST WhatsApp-suite entitlement gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetStripeServiceForTests();
    getZkLoginSessionStore().clear();
    setBillingEnabled(false);

    getZkLoginSessionStore().set(SESSION_ID, buildSessionRecord(ADMIN_ADDRESS));
    (fetchCircleAdminAddress as jest.Mock).mockResolvedValue(ADMIN_ADDRESS);
    (getActiveWhatsAppRegistries as jest.Mock).mockReturnValue([
      { packageId: '0xpkg', registryObjectId: '0xreg' },
    ]);
    (encryptAndStorePII as jest.Mock).mockResolvedValue({
      walrusBlobId: 'blob-1',
      linkNonce: new Uint8Array([1, 2, 3, 4]),
    });
  });

  afterAll(() => {
    if (ORIGINAL_FLAG === undefined) {
      delete process.env.NEXT_PUBLIC_BILLING_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_BILLING_ENABLED = ORIGINAL_FLAG;
    }
  });

  it('links freely while the billing kill switch is off', async () => {
    const res = createMockRes();

    await handler(createLinkReq(), res);

    expect(res.statusCode).toBe(200);
    expect(encryptAndStorePII).toHaveBeenCalled();
  });

  it('returns 402 with the typed body for an unentitled admin and runs zero side effects', async () => {
    setBillingEnabled(true);
    const res = createMockRes();

    await handler(createLinkReq(), res);

    expect(res.statusCode).toBe(402);
    expect(res.jsonBody).toEqual(
      expect.objectContaining({
        success: false,
        error: 'UPGRADE_REQUIRED',
        code: 'UPGRADE_REQUIRED',
        feature: 'whatsappSuite',
        requiredPlan: 'premium',
        upgradeUrl: '/pricing',
      }),
    );
    // The gate runs after admin auth but BEFORE any side effect.
    expect(encryptAndStorePII).not.toHaveBeenCalled();
    expect(enokiZkLoginService.sendTransaction).not.toHaveBeenCalled();
    expect(indexWhatsAppLink).not.toHaveBeenCalled();
  });

  it('lets a premium admin link (subscription matched by address)', async () => {
    setBillingEnabled(true);
    await seedPremiumSubscriptionForAdmin();
    const res = createMockRes();

    await handler(createLinkReq(), res);

    expect(res.statusCode).toBe(200);
    expect(encryptAndStorePII).toHaveBeenCalled();
  });

  it('still requires admin auth before the entitlement check (401 wins over 402)', async () => {
    setBillingEnabled(true);
    getZkLoginSessionStore().clear();
    const res = createMockRes();

    await handler(createLinkReq(), res);

    expect(res.statusCode).toBe(401);
    expect(encryptAndStorePII).not.toHaveBeenCalled();
  });
});
