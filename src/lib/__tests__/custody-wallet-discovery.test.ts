/**
 * Custody wallet discovery must survive event retention.
 *
 * The regression this guards: recovery execution needs the CustodyWallet id,
 * every page discovered it ONLY via the `CustodyWalletCreated` event, and that
 * event ages out of the single RPC endpoint that serves event queries. A
 * passed member-majority emergency stop then could not be executed through
 * the UI — observed live on testnet 2026-08-15 with 2/2 votes on chain and
 * the contract accepting the call in simulation.
 */
import type { SuiClient } from '@mysten/sui/client';
import {
  resolveCustodyWalletId,
  isCustodyWalletForCircle,
  resolveCustodyStablecoinType,
} from '@/lib/custody-wallet-discovery';
import { readFileSync } from 'fs';
import { join } from 'path';

const PKG = '0x' + '11'.repeat(32);
const CIRCLE = '0x' + 'c1'.repeat(32);
const WALLET = '0x' + 'aa'.repeat(32);
const CLOCK = '0x' + '00'.repeat(31) + '06';
const USER = '0x' + 'bb'.repeat(32);

const custodyWalletObject = {
  data: {
    type: `${PKG}::njangi_custody::CustodyWallet`,
    content: { dataType: 'moveObject', fields: { circle_id: CIRCLE } },
  },
};

const someOtherObject = {
  data: {
    type: `${PKG}::njangi_circles::Circle`,
    content: { dataType: 'moveObject', fields: {} },
  },
};

function makeClient(overrides: Partial<Record<keyof SuiClient, unknown>> = {}): SuiClient {
  return {
    getObject: jest.fn(async ({ id }: { id: string }) =>
      id === WALLET ? custodyWalletObject : someOtherObject,
    ),
    getDynamicFieldObject: jest.fn(async () => ({ data: null })),
    queryEvents: jest.fn(async () => ({ data: [] })),
    queryTransactionBlocks: jest.fn(async () => ({ data: [] })),
    ...overrides,
  } as unknown as SuiClient;
}

const fieldHolding = (value: string) => ({
  data: {
    content: { dataType: 'moveObject', fields: { name: 'wallet_id', value } },
  },
});

const depositTx = {
  transaction: {
    data: {
      transaction: {
        kind: 'ProgrammableTransaction',
        transactions: [
          { MoveCall: { package: PKG, module: 'njangi_circles', function: 'member_deposit_security_deposit' } },
        ],
        inputs: [
          { type: 'object', objectId: CIRCLE },
          { type: 'object', objectId: WALLET },
          { type: 'object', objectId: CLOCK },
          { type: 'pure', value: '300000' },
        ],
      },
    },
  },
};

describe('resolveCustodyWalletId', () => {
  it('uses the wallet_id dynamic field when it is real, without touching events', async () => {
    const client = makeClient({
      getDynamicFieldObject: jest.fn(async () => fieldHolding(WALLET)),
    });
    const queryEvents = jest.fn();

    const result = await resolveCustodyWalletId({
      client, circleId: CIRCLE, packageId: PKG, queryEvents,
    });

    expect(result).toEqual({ walletId: WALLET, source: 'dynamic_field' });
    expect(queryEvents).not.toHaveBeenCalled();
  });

  it('treats the create-flow placeholder (field = circle id) as unset', async () => {
    // njangi_circles.move:584 seeds the field with the circle's OWN id.
    // Trusting it would hand every downstream read the wrong object.
    const client = makeClient({
      getDynamicFieldObject: jest.fn(async () => fieldHolding(CIRCLE)),
    });
    const queryEvents = jest.fn(async () => ({
      data: [{ parsedJson: { circle_id: CIRCLE, wallet_id: WALLET } }],
    }));

    const result = await resolveCustodyWalletId({
      client, circleId: CIRCLE, packageId: PKG, queryEvents,
    });

    expect(result).toEqual({ walletId: WALLET, source: 'events' });
  });

  it('recovers the wallet from the caller’s own deposit when events have aged out', async () => {
    // THE regression case: placeholder field, empty event history (HTTP 200,
    // zero rows — retention, not an outage), and a member who deposited.
    const client = makeClient({
      getDynamicFieldObject: jest.fn(async () => fieldHolding(CIRCLE)),
      queryTransactionBlocks: jest.fn(async () => ({ data: [depositTx] })),
    });
    const queryEvents = jest.fn(async () => ({ data: [] }));

    const result = await resolveCustodyWalletId({
      client, circleId: CIRCLE, packageId: PKG, userAddress: USER, queryEvents,
    });

    expect(result).toEqual({ walletId: WALLET, source: 'transaction_history' });
  });

  it('rejects candidates that do not validate as this circle’s CustodyWallet', async () => {
    // An event naming some other object must not be trusted just because it
    // parsed — validation is what makes the whole scheme safe.
    const IMPOSTER = '0x' + 'dd'.repeat(32);
    const client = makeClient({
      queryEvents: jest.fn(async () => ({
        data: [{ parsedJson: { circle_id: CIRCLE, wallet_id: IMPOSTER } }],
      })),
    });

    const result = await resolveCustodyWalletId({
      client, circleId: CIRCLE, packageId: PKG,
    });

    expect(result).toBeNull();
  });

  it('returns null when every tier fails, so callers gate rather than guess', async () => {
    const result = await resolveCustodyWalletId({
      client: makeClient(), circleId: CIRCLE, packageId: PKG, userAddress: USER,
    });
    expect(result).toBeNull();
  });
});

describe('isCustodyWalletForCircle', () => {
  it('accepts only a CustodyWallet whose circle_id points back at the circle', async () => {
    const client = makeClient();
    expect(await isCustodyWalletForCircle(client, WALLET, CIRCLE)).toBe(true);
    expect(await isCustodyWalletForCircle(client, CIRCLE, CIRCLE)).toBe(false);
  });
});

describe('pages no longer hard-wire event-only discovery', () => {
  // The string may live only in the resolver (and in sites that are display-
  // only). The three custody-CRITICAL pages must go through the resolver, or
  // the retention failure comes straight back.
  const CRITICAL_PAGES = [
    'src/pages/circle/[id]/manage/index.tsx',
    'src/pages/circle/[id]/index.tsx',
    'src/pages/circle/[id]/contribute/index.tsx',
  ];

  it.each(CRITICAL_PAGES)('%s resolves custody via the shared resolver', (rel) => {
    const source = readFileSync(join(process.cwd(), rel), 'utf8');
    expect(source).not.toContain('CustodyWalletCreated');
    expect(source).toContain('resolveCustodyWalletId');
  });
});

describe('resolveCustodyStablecoinType', () => {
  const USDC_UNPREFIXED = '26b3'.padEnd(4, '0') + 'ab'.repeat(30) + '::usdc::USDC';

  it('prefers the configured target coin type when present', async () => {
    const client = makeClient({
      getObject: jest.fn(async () => ({
        data: {
          type: `${PKG}::njangi_custody::CustodyWallet`,
          content: {
            dataType: 'moveObject',
            fields: { stablecoin_config: { fields: { target_coin_type: `0x2::usdc::USDC` } } },
          },
        },
      })),
    });
    expect(await resolveCustodyStablecoinType(client, WALLET)).toBe('0x2::usdc::USDC');
  });

  it('falls back to the wallet balance fields when the config is None — the retention case', async () => {
    // Live shape observed on testnet: stablecoin_config null, but the wallet
    // carries a Balance<T> dynamic field keyed by the (unprefixed) coin type.
    const client = makeClient({
      getObject: jest.fn(async () => ({
        data: {
          type: `${PKG}::njangi_custody::CustodyWallet`,
          content: { dataType: 'moveObject', fields: { stablecoin_config: null } },
        },
      })),
      getDynamicFields: jest.fn(async () => ({
        data: [
          { name: { value: 'registered_types' }, objectType: 'vector<0x1::string::String>' },
          { name: { value: USDC_UNPREFIXED }, objectType: '0x2::balance::Balance<0x…::usdc::USDC>' },
        ],
      })),
    });
    expect(await resolveCustodyStablecoinType(client, WALLET)).toBe(`0x${USDC_UNPREFIXED}`);
  });

  it('never answers with the SUI type — recovery unwinds the stablecoin leg', async () => {
    const client = makeClient({
      getObject: jest.fn(async () => ({
        data: {
          type: `${PKG}::njangi_custody::CustodyWallet`,
          content: { dataType: 'moveObject', fields: { stablecoin_config: null } },
        },
      })),
      getDynamicFields: jest.fn(async () => ({
        data: [{ name: { value: '2::sui::SUI' }, objectType: '0x2::balance::Balance<0x2::sui::SUI>' }],
      })),
    });
    expect(await resolveCustodyStablecoinType(client, WALLET)).toBeNull();
  });
});

/**
 * The tier that carries production.
 *
 * `create_circle` seeds the `wallet_id` dynamic field with the CIRCLE'S OWN
 * id as a placeholder, so the dynamic-field tier rejects it on every circle
 * and discovery fell through to an event scan the primary RPC cannot serve.
 * The wallet was therefore permanently unresolvable, which disables every
 * payment control and silently breaks member removal.
 */
describe('resolveCustodyWalletId — creation transaction tier', () => {
  const CIRCLE = '0x0478ee8482627fd53f13dfbeebc0bcaf369189c1d20256ea91abc0dd6f0c91b3';
  const WALLET = '0x19ef0c85eb6771548bcf74f76212f70c72dd8a3620c7c0ef954c22844f497e33';
  const WALLET_TYPE = '0xabc::njangi_custody::CustodyWallet';

  const clientWith = (overrides: Record<string, unknown> = {}) =>
    ({
      // Placeholder value: the field holds the circle id, as the contract writes it.
      getDynamicFieldObject: jest.fn().mockResolvedValue({
        data: {
          previousTransaction: 'CREATE_DIGEST',
          content: { dataType: 'moveObject', fields: { value: CIRCLE } },
        },
      }),
      getTransactionBlock: jest.fn().mockResolvedValue({
        objectChanges: [
          { type: 'created', objectId: WALLET, objectType: WALLET_TYPE },
          { type: 'created', objectId: '0xdead', objectType: '0xabc::njangi_circles::Circle' },
        ],
      }),
      getObject: jest.fn().mockResolvedValue({
        data: { type: WALLET_TYPE, content: { dataType: 'moveObject', fields: { circle_id: CIRCLE } } },
      }),
      queryEvents: jest.fn().mockRejectedValue(new Error('event history unavailable')),
      queryTransactionBlocks: jest.fn().mockResolvedValue({ data: [] }),
      ...overrides,
    }) as unknown as Parameters<typeof resolveCustodyWalletId>[0]['client'];

  it('resolves through the creation transaction when the field holds the placeholder', async () => {
    const client = clientWith();

    const res = await resolveCustodyWalletId({ client, circleId: CIRCLE, packageId: '0xabc' });

    expect(res).toEqual({ walletId: WALLET, source: 'creation_tx' });
  });

  // The whole point: it must not need event history.
  it('does not depend on the event scan', async () => {
    const queryEvents = jest.fn().mockRejectedValue(new Error('endpoint refuses event history'));
    const client = clientWith({ queryEvents });

    const res = await resolveCustodyWalletId({ client, circleId: CIRCLE, packageId: '0xabc' });

    expect(res?.walletId).toBe(WALLET);
    expect(queryEvents).not.toHaveBeenCalled();
  });

  it('refuses to guess when the creating transaction made several wallets', async () => {
    const client = clientWith({
      getTransactionBlock: jest.fn().mockResolvedValue({
        objectChanges: [
          { type: 'created', objectId: WALLET, objectType: WALLET_TYPE },
          { type: 'created', objectId: '0xother', objectType: WALLET_TYPE },
        ],
      }),
    });

    const res = await resolveCustodyWalletId({ client, circleId: CIRCLE, packageId: '0xabc' });

    expect(res).toBeNull();
  });

  it('falls through when the field has no creating transaction', async () => {
    const client = clientWith({
      getDynamicFieldObject: jest.fn().mockResolvedValue({ data: { content: null } }),
    });

    const res = await resolveCustodyWalletId({ client, circleId: CIRCLE, packageId: '0xabc' });

    expect(res).toBeNull();
  });

  // A wallet belonging to a different circle must never be accepted.
  it('rejects a wallet whose circle_id does not match', async () => {
    const client = clientWith({
      getObject: jest.fn().mockResolvedValue({
        data: { type: WALLET_TYPE, content: { dataType: 'moveObject', fields: { circle_id: '0xdifferent' } } },
      }),
    });

    const res = await resolveCustodyWalletId({ client, circleId: CIRCLE, packageId: '0xabc' });

    expect(res).toBeNull();
  });
});
