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
    // njangi_circles.move:639 seeds the field with the circle's OWN id.
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

  it('is tri-state: a nonexistent object is false, an unreadable one is null', async () => {
    // `false` rejects the candidate for good; `null` leaves it undecided. A
    // transient error that came back as `false` would reject the CORRECT
    // wallet and take every money-out control with it.
    const client = makeClient({
      getObject: jest.fn(async ({ id }: { id: string }) =>
        id === WALLET
          ? { error: { code: 'unknown' } }
          : { error: { code: 'notExists', object_id: id } },
      ),
    });
    expect(await isCustodyWalletForCircle(client, WALLET, CIRCLE)).toBeNull();
    expect(await isCustodyWalletForCircle(client, CIRCLE, CIRCLE)).toBe(false);

    const throwing = makeClient({ getObject: jest.fn().mockRejectedValue(new Error('429')) });
    expect(await isCustodyWalletForCircle(throwing, WALLET, CIRCLE)).toBeNull();
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

  // Siblings the creating transaction also minted: one of the circle's
  // dynamic-field objects, and (hypothetically) a CustodyWallet belonging to
  // some OTHER circle. Full-length ids, because the batched validator sends
  // normalized ids and a short fixture would not round-trip through the mock.
  const FIELD_OBJECT = '0x' + 'f1'.repeat(32);
  const IMPOSTER = '0x' + 'ee'.repeat(32);
  const OTHER_CIRCLE = '0x' + '99'.repeat(32);

  const walletObject = {
    data: { type: WALLET_TYPE, content: { dataType: 'moveObject', fields: { circle_id: CIRCLE } } },
  };
  const objectsById: Record<string, unknown> = {
    [WALLET]: walletObject,
    [CIRCLE]: {
      data: { type: '0xabc::njangi_circles::Circle', content: { dataType: 'moveObject', fields: {} } },
    },
    [FIELD_OBJECT]: {
      data: {
        type: '0x2::dynamic_field::Field<0x1::string::String, 0x2::object::ID>',
        content: { dataType: 'moveObject', fields: { name: 'wallet_id', value: CIRCLE } },
      },
    },
    [IMPOSTER]: {
      data: { type: WALLET_TYPE, content: { dataType: 'moveObject', fields: { circle_id: OTHER_CIRCLE } } },
    },
  };
  const lookup = (id: string) => objectsById[id] ?? { error: { code: 'notExists', object_id: id } };
  const idAwareMultiGet = () => jest.fn(async ({ ids }: { ids: string[] }) => ids.map(lookup));

  /** An `effects.created` entry: a bare object reference, no type. */
  const createdRef = (objectId: string) => ({
    owner: 'Immutable',
    reference: { objectId, version: '1', digest: 'objdigest' },
  });

  const clientWith = (overrides: Record<string, unknown> = {}) => {
    const base: Record<string, unknown> = {
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
      getObject: jest.fn().mockResolvedValue(walletObject),
      queryEvents: jest.fn().mockRejectedValue(new Error('event history unavailable')),
      queryTransactionBlocks: jest.fn().mockResolvedValue({ data: [] }),
      ...overrides,
    };
    // The creation tier validates through multiGetObjects. Unless a test says
    // otherwise, each id answers exactly as getObject would, so a per-test
    // getObject override governs both read paths.
    base.multiGetObjects ??= jest.fn(async ({ ids }: { ids: string[] }) =>
      Promise.all(
        ids.map((id) => (base.getObject as (args: { id: string }) => Promise<unknown>)({ id })),
      ),
    );
    return base as unknown as Parameters<typeof resolveCustodyWalletId>[0]['client'];
  };

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

  /**
   * The 2026-08-30 production failure. sui-testnet-rpc.publicnode.com keeps
   * a stub of an old transaction: `status: success`, `objectChanges: []`,
   * yet `effects.created` still lists every object it made. An empty change
   * list read as "no wallet was created", the tier returned null, and the
   * event tier it fell through to is one that endpoint cannot serve at all.
   * The deposit button on a live circle never rendered.
   */
  describe('when the node strips objectChanges but keeps effects', () => {
    it('asks for effects and resolves the wallet from effects.created', async () => {
      const getTransactionBlock = jest.fn().mockResolvedValue({
        digest: 'CREATE_DIGEST',
        objectChanges: [],
        effects: {
          status: { status: 'success' },
          created: [createdRef(CIRCLE), createdRef(FIELD_OBJECT), createdRef(WALLET)],
        },
      });
      const multiGetObjects = idAwareMultiGet();
      const queryEvents = jest.fn().mockRejectedValue(new Error('-32603'));
      const client = clientWith({ getTransactionBlock, multiGetObjects, queryEvents });

      const res = await resolveCustodyWalletId({ client, circleId: CIRCLE, packageId: '0xabc' });

      expect(res).toEqual({ walletId: WALLET, source: 'creation_tx' });
      expect(getTransactionBlock).toHaveBeenCalledWith(
        expect.objectContaining({
          digest: 'CREATE_DIGEST',
          options: expect.objectContaining({ showEffects: true }),
        }),
      );
      // Every created reference resolved in ONE round-trip, and the
      // unserved event tier was never needed.
      expect(multiGetObjects).toHaveBeenCalledTimes(1);
      expect(multiGetObjects.mock.calls[0][0].ids).toEqual([CIRCLE, FIELD_OBJECT, WALLET]);
      expect(queryEvents).not.toHaveBeenCalled();
    });

    it('picks the single created object that validates when several are plausible', async () => {
      // effects.created carries ids only — no types — so every created object
      // is a candidate until read: the Circle, a field object, and here a
      // CustodyWallet whose circle_id points at some other circle.
      const multiGetObjects = idAwareMultiGet();
      const client = clientWith({
        getTransactionBlock: jest.fn().mockResolvedValue({
          objectChanges: [],
          effects: {
            created: [createdRef(IMPOSTER), createdRef(CIRCLE), createdRef(WALLET), createdRef(FIELD_OBJECT)],
          },
        }),
        multiGetObjects,
      });

      const res = await resolveCustodyWalletId({ client, circleId: CIRCLE, packageId: '0xabc' });

      expect(res).toEqual({ walletId: WALLET, source: 'creation_tx' });
      expect(multiGetObjects).toHaveBeenCalledTimes(1);
    });

    it('still refuses to guess when two created objects both validate', async () => {
      const TWIN = '0x' + '77'.repeat(32);
      const multiGetObjects = jest.fn(async ({ ids }: { ids: string[] }) =>
        ids.map((id) => (id === TWIN ? walletObject : lookup(id))),
      );
      const client = clientWith({
        getTransactionBlock: jest.fn().mockResolvedValue({
          objectChanges: [],
          effects: { created: [createdRef(WALLET), createdRef(TWIN)] },
        }),
        multiGetObjects,
      });

      const res = await resolveCustodyWalletId({ client, circleId: CIRCLE, packageId: '0xabc' });

      expect(res).toBeNull();
    });

    it('lets an unreadable sibling neither veto nor impersonate the wallet', async () => {
      // Tri-state inside the batch: a per-object `unknown` error is "could
      // not read", not "is not the wallet" and not "is a second wallet".
      const UNREADABLE = '0x' + 'ab'.repeat(32);
      const multiGetObjects = jest.fn(async ({ ids }: { ids: string[] }) =>
        ids.map((id) => (id === UNREADABLE ? { error: { code: 'unknown' } } : lookup(id))),
      );
      const client = clientWith({
        getTransactionBlock: jest.fn().mockResolvedValue({
          objectChanges: [],
          effects: { created: [createdRef(UNREADABLE), createdRef(WALLET)] },
        }),
        multiGetObjects,
      });

      const res = await resolveCustodyWalletId({ client, circleId: CIRCLE, packageId: '0xabc' });

      expect(res).toEqual({ walletId: WALLET, source: 'creation_tx' });
    });

    it('treats a failed batch read (rate limit) as unresolved and lets later tiers try', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const queryEvents = jest.fn().mockResolvedValue({ data: [] });
      const client = clientWith({
        getTransactionBlock: jest.fn().mockResolvedValue({
          objectChanges: [],
          effects: { created: [createdRef(CIRCLE), createdRef(WALLET)] },
        }),
        multiGetObjects: jest.fn().mockRejectedValue(new Error('429 Your request is too frequent')),
        queryEvents,
      });

      const res = await resolveCustodyWalletId({ client, circleId: CIRCLE, packageId: '0xabc' });

      expect(res).toBeNull();
      expect(queryEvents).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('read failed'),
        expect.objectContaining({ digest: 'CREATE_DIGEST' }),
      );
    });
  });

  it('keeps the typed fast path: with full object changes only the wallet-typed creation is read', async () => {
    const multiGetObjects = idAwareMultiGet();
    const client = clientWith({ multiGetObjects });

    const res = await resolveCustodyWalletId({ client, circleId: CIRCLE, packageId: '0xabc' });

    expect(res).toEqual({ walletId: WALLET, source: 'creation_tx' });
    expect(multiGetObjects).toHaveBeenCalledTimes(1);
    expect(multiGetObjects.mock.calls[0][0].ids).toEqual([WALLET]);
  });

  /**
   * Neither view survived: the node pruned the transaction past usefulness.
   * That is a read failure, and it must not be recorded as the fact "this
   * circle has no wallet" — a circle cannot exist without its creating
   * transaction having made objects.
   */
  it('treats a transaction with neither object changes nor created effects as unreadable, not as "no wallet"', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const multiGetObjects = idAwareMultiGet();
    const queryEvents = jest.fn().mockResolvedValue({ data: [] });
    const client = clientWith({
      getTransactionBlock: jest.fn().mockResolvedValue({
        digest: 'CREATE_DIGEST',
        objectChanges: [],
        effects: { status: { status: 'success' }, created: [] },
      }),
      multiGetObjects,
      queryEvents,
    });

    const res = await resolveCustodyWalletId({ client, circleId: CIRCLE, packageId: '0xabc' });

    expect(res).toBeNull();
    // Nothing to resolve, so no batch read was attempted ...
    expect(multiGetObjects).not.toHaveBeenCalled();
    // ... the later tiers still got their turn ...
    expect(queryEvents).toHaveBeenCalled();
    // ... and the failure is named with its digest instead of swallowed.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('pruned'),
      expect.objectContaining({ circleId: CIRCLE, digest: 'CREATE_DIGEST' }),
    );
  });

  it('treats a node that no longer has the transaction (-32602) the same way', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const queryEvents = jest.fn().mockResolvedValue({ data: [] });
    const client = clientWith({
      getTransactionBlock: jest
        .fn()
        .mockRejectedValue(new Error('-32602 Could not find the referenced transaction')),
      queryEvents,
    });

    const res = await resolveCustodyWalletId({ client, circleId: CIRCLE, packageId: '0xabc' });

    expect(res).toBeNull();
    expect(queryEvents).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('read failed'),
      expect.objectContaining({ digest: 'CREATE_DIGEST' }),
    );
  });
});
