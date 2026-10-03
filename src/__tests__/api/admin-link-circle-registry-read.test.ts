/**
 * GET /api/whatsapp/admin-link-circle — the public link-status probe.
 *
 * Regression guarded here: when the on-chain WhatsApp registry could not be
 * read (a wrong or deleted registry id, a node error, an object that is not
 * the registry), the route answered 200 `isLinked: false` with "Registry not
 * yet indexed", so the manage card offered "Link to WhatsApp" for a circle
 * that may already be linked. Only a registry that was actually read may say
 * "not linked"; anything else answers 503 WHATSAPP_REGISTRY_UNREADABLE.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

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

import handler from '@/pages/api/whatsapp/admin-link-circle';
import { getActiveWhatsAppRegistries } from '@/services/whatsapp-registry-service';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';

const CIRCLE_ID = '0x' + 'c3'.repeat(32);
const OTHER_CIRCLE_ID = '0x' + 'd4'.repeat(32);

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

function probe(): NextApiRequest {
  return {
    method: 'GET',
    url: '/api/whatsapp/admin-link-circle',
    headers: {},
    socket: {},
    cookies: {},
    query: { circleId: CIRCLE_ID, network: 'testnet' },
    body: undefined,
  } as unknown as NextApiRequest;
}

function registryWithLinks(links: unknown[]) {
  return {
    data: {
      content: {
        dataType: 'moveObject',
        type: '0xpkg::whatsapp_integration::WhatsAppLinksRegistry',
        fields: { links, total_links: String(links.length) },
      },
    },
  };
}

function linkFor(circleId: string) {
  return {
    fields: {
      circle_id: circleId,
      enabled: true,
      link_type: 1,
      walrus_blob_id: Array.from(Buffer.from('blob-1', 'utf8')),
      link_nonce: [1, 2, 3, 4],
    },
  };
}

function mockRegistryRead(getObject: jest.Mock) {
  (getPooledSuiClient as jest.Mock).mockReturnValue({ getObject });
}

async function runProbe(): Promise<MockRes> {
  const res = createMockRes();
  await handler(probe(), res);
  return res;
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (getActiveWhatsAppRegistries as jest.Mock).mockReturnValue([
    { packageId: '0xpkg', registryObjectId: '0xreg' },
  ]);
});

describe('admin-link-circle GET when the registry cannot be read', () => {
  it('answers 503, not isLinked:false, when the registry id does not resolve to an object', async () => {
    mockRegistryRead(
      jest.fn().mockResolvedValue({ error: { code: 'notExists', object_id: '0xreg' } }),
    );

    const res = await runProbe();

    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toMatchObject({ success: false, code: 'WHATSAPP_REGISTRY_UNREADABLE' });
    expect(JSON.stringify(res.jsonBody)).not.toContain('isLinked');
  });

  it('answers 503 when the object read has no links vector (not the registry)', async () => {
    mockRegistryRead(
      jest.fn().mockResolvedValue({
        data: { content: { dataType: 'moveObject', type: '0x2::coin::Coin<0x2::sui::SUI>', fields: { balance: '1' } } },
      }),
    );

    const res = await runProbe();

    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toMatchObject({ code: 'WHATSAPP_REGISTRY_UNREADABLE' });
  });

  it('answers 503 when the reply carries no content at all', async () => {
    mockRegistryRead(jest.fn().mockResolvedValue({ data: { objectId: '0xreg' } }));

    const res = await runProbe();

    expect(res.statusCode).toBe(503);
  });

  it('answers a non-2xx error when the RPC read throws', async () => {
    mockRegistryRead(jest.fn().mockRejectedValue(new Error('All configured Sui RPC endpoints are in rate limit cooldown')));

    const res = await runProbe();

    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.jsonBody)).not.toContain('isLinked');
  });
});

describe('admin-link-circle GET when the registry was read', () => {
  it('answers isLinked:false for a circle the registry does not list', async () => {
    mockRegistryRead(jest.fn().mockResolvedValue(registryWithLinks([linkFor(OTHER_CIRCLE_ID)])));

    const res = await runProbe();

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ success: true, data: { isLinked: false } });
  });

  it('answers isLinked:false for an empty registry', async () => {
    mockRegistryRead(jest.fn().mockResolvedValue(registryWithLinks([])));

    const res = await runProbe();

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ success: true, data: { isLinked: false } });
  });

  it('answers isLinked:true for a circle the registry lists', async () => {
    mockRegistryRead(jest.fn().mockResolvedValue(registryWithLinks([linkFor(CIRCLE_ID)])));

    const res = await runProbe();

    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toMatchObject({ success: true, data: { isLinked: true, linkType: 1 } });
  });
});
