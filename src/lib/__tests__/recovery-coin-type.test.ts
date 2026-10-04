/**
 * The CoinType that execute_recovery / trigger_auto_release are signed with.
 *
 * The regression this guards: a circle whose members all paid in SUI holds no
 * stablecoin, the old resolver returned null for it, and the circle page
 * stopped at "Stablecoin type is unavailable" — a passed emergency stop could
 * not be executed and auto-release could not be triggered. With no stablecoin
 * in the wallet, get_stablecoin_balance<T> reads zero for every T, so any type
 * that exists on chain works; the network's USDC is used. Verified with
 * devInspect on testnet 2026-10-03: a SUI security deposit into the empty
 * wallet of circle 0x0205295c…, then propose → vote → execute_recovery<USDC>
 * succeeded and refunded the SUI.
 *
 * Fixture shapes are the live JSON-RPC ones from testnet custody wallets
 * (e.g. 0x812d3b4a…, which holds USDC).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { SuiClient } from '@mysten/sui/client';
import {
  RecoveryCoinTypeError,
  chooseRecoveryCoinType,
  readCustodyCoinHoldings,
  recoveryCoinTypeErrorMessage,
  resolveRecoveryCoinType,
} from '@/lib/recovery-coin-type';

const WALLET = '0x' + 'aa'.repeat(32);
const FRAMEWORK = '0x' + '0'.repeat(63) + '2';
const USDC_ADDRESS = '26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc';
const USDC = `0x${USDC_ADDRESS}::usdc::USDC`;
const OTHER_STABLE = '0x' + 'cd'.repeat(32) + '::usdt::USDT';
const SUI = `${FRAMEWORK}::sui::SUI`;
/** What the app passes as the fallback: the network's `coinTypes.USDC`. */
const CONFIGURED_USDC = USDC;

type Entry = {
  name: { type: string; value: unknown };
  type: 'DynamicField' | 'DynamicObject';
  objectType: string;
  objectId: string;
};

/**
 * `registered_types`: every coin type the wallet ever stored (its value is not
 * part of the listing). A record of the past, not of holdings.
 */
const REGISTERED_TYPES: Entry = {
  name: { type: '0x1::string::String', value: 'registered_types' },
  type: 'DynamicField',
  objectType: `vector<0x${'0'.repeat(63)}1::string::String>`,
  objectId: '0x' + '01'.repeat(32),
};

/** dynamic_field<String, Balance<T>> keyed by T's unprefixed type name. */
const typedBalance = (coinType: string): Entry => ({
  name: { type: '0x1::string::String', value: coinType.replace(/^0x/, '') },
  type: 'DynamicField',
  objectType: `${FRAMEWORK}::balance::Balance<${coinType}>`,
  objectId: '0x' + '02'.repeat(32),
});

/** The pre-2026-03 dynamic_object_field<String, Coin<T>> named "coin_objects". */
const legacyCoin = (coinType: string): Entry => ({
  name: { type: '0x1::string::String', value: 'coin_objects' },
  type: 'DynamicObject',
  objectType: `${FRAMEWORK}::coin::Coin<${coinType}>`,
  objectId: '0x' + '03'.repeat(32),
});

const SUI_BALANCE = typedBalance(SUI);

function clientWithPages(...pages: Entry[][]) {
  const getDynamicFields = jest.fn(async ({ cursor }: { cursor?: string | null }) => {
    const index = cursor ? Number(cursor.replace('page-', '')) : 0;
    const hasNextPage = index < pages.length - 1;
    return {
      data: pages[index],
      hasNextPage,
      nextCursor: hasNextPage ? `page-${index + 1}` : null,
    };
  });
  return { client: { getDynamicFields } as unknown as SuiClient, getDynamicFields };
}

const failingClient = (error: unknown = new Error('429 Too Many Requests')) =>
  ({ getDynamicFields: jest.fn(async () => { throw error; }) }) as unknown as SuiClient;

describe('rule 1 — the wallet holds a stablecoin: pass its own type', () => {
  it('reads the type of a typed Balance<T> field (the live testnet shape)', async () => {
    const { client } = clientWithPages([REGISTERED_TYPES, typedBalance(USDC)]);
    await expect(resolveRecoveryCoinType(client, WALLET, CONFIGURED_USDC)).resolves.toEqual({
      coinType: USDC,
      source: 'stablecoin_balance',
    });
  });

  it('uses the coin the wallet holds, not the configured USDC', async () => {
    const { client } = clientWithPages([SUI_BALANCE, typedBalance(OTHER_STABLE)]);
    await expect(resolveRecoveryCoinType(client, WALLET, CONFIGURED_USDC)).resolves.toEqual({
      coinType: OTHER_STABLE,
      source: 'stablecoin_balance',
    });
  });

  it('uses the legacy Coin<T> field type when that field exists', async () => {
    const { client } = clientWithPages([REGISTERED_TYPES, legacyCoin(OTHER_STABLE)]);
    await expect(resolveRecoveryCoinType(client, WALLET, CONFIGURED_USDC)).resolves.toEqual({
      coinType: OTHER_STABLE,
      source: 'legacy_coin',
    });
  });

  it('lets the legacy field win: the contract borrows it as Coin<CoinType> whatever else is held', async () => {
    // Even a legacy SUI coin: get_stablecoin_balance<USDC> would abort on it.
    const { client } = clientWithPages([SUI_BALANCE, legacyCoin(SUI)]);
    await expect(resolveRecoveryCoinType(client, WALLET, CONFIGURED_USDC)).resolves.toEqual({
      coinType: SUI,
      source: 'legacy_coin',
    });

    const sameCoinBothWays = clientWithPages([typedBalance(OTHER_STABLE), legacyCoin(OTHER_STABLE)]);
    await expect(
      resolveRecoveryCoinType(sameCoinBothWays.client, WALLET, CONFIGURED_USDC),
    ).resolves.toEqual({ coinType: OTHER_STABLE, source: 'legacy_coin' });
  });

  it('recognises the legacy field when its name arrives still wrapped', async () => {
    const wrapped: Entry = {
      ...legacyCoin(OTHER_STABLE),
      name: {
        type: '0x2::dynamic_object_field::Wrapper<0x1::string::String>',
        value: { name: 'coin_objects' },
      },
    };
    const { client } = clientWithPages([wrapped]);
    await expect(resolveRecoveryCoinType(client, WALLET, CONFIGURED_USDC)).resolves.toEqual({
      coinType: OTHER_STABLE,
      source: 'legacy_coin',
    });
  });

  it('finds a stablecoin on a later page instead of concluding there is none', async () => {
    const { client, getDynamicFields } = clientWithPages(
      [REGISTERED_TYPES, SUI_BALANCE],
      [typedBalance(OTHER_STABLE)],
    );
    await expect(resolveRecoveryCoinType(client, WALLET, CONFIGURED_USDC)).resolves.toEqual({
      coinType: OTHER_STABLE,
      source: 'stablecoin_balance',
    });
    expect(getDynamicFields).toHaveBeenCalledTimes(2);
  });

  it('compares the whole type, so a look-alike `::sui::SUI` coin is not mistaken for SUI', async () => {
    const lookalike = '0x' + 'ee'.repeat(32) + '::sui::SUI';
    const { client } = clientWithPages([typedBalance(lookalike)]);
    await expect(resolveRecoveryCoinType(client, WALLET, CONFIGURED_USDC)).resolves.toEqual({
      coinType: lookalike,
      source: 'stablecoin_balance',
    });
  });

  it('ignores a Balance<T> stored under some other key: get_stablecoin_balance<T> never reads it', async () => {
    const misfiled: Entry = { ...typedBalance(OTHER_STABLE), name: { type: '0x1::string::String', value: 'escrow' } };
    const { client } = clientWithPages([misfiled]);
    await expect(resolveRecoveryCoinType(client, WALLET, CONFIGURED_USDC)).resolves.toEqual({
      coinType: CONFIGURED_USDC,
      source: 'no_stablecoin',
    });
  });
});

describe('rule 2 — the wallet holds no stablecoin: the network USDC type', () => {
  it('falls back for a circle whose members all paid in SUI', async () => {
    const { client } = clientWithPages([REGISTERED_TYPES, SUI_BALANCE]);
    await expect(resolveRecoveryCoinType(client, WALLET, CONFIGURED_USDC)).resolves.toEqual({
      coinType: CONFIGURED_USDC,
      source: 'no_stablecoin',
    });
  });

  it('falls back for an empty wallet and for one whose stablecoin was all refunded', async () => {
    // Live testnet: 0xc4d4c77b… lists no fields; 0xde4d54b3… lists only
    // registered_types, which records types ever stored, not holdings.
    for (const page of [[], [REGISTERED_TYPES]]) {
      const { client } = clientWithPages(page);
      await expect(resolveRecoveryCoinType(client, WALLET, CONFIGURED_USDC)).resolves.toEqual({
        coinType: CONFIGURED_USDC,
        source: 'no_stablecoin',
      });
    }
  });

  it('passes the configured type through unchanged, so the refund labels still match it', () => {
    expect(
      chooseRecoveryCoinType({ stablecoinTypes: [], legacyCoinType: null }, `  ${CONFIGURED_USDC} `).coinType,
    ).toBe(CONFIGURED_USDC);
  });

  it('refuses a missing or SUI fallback rather than signing with it', () => {
    const none = { stablecoinTypes: [], legacyCoinType: null };
    expect(() => chooseRecoveryCoinType(none, '')).toThrow(/No usable USDC coin type/);
    expect(() => chooseRecoveryCoinType(none, '0x2::sui::SUI')).toThrow(/No usable USDC coin type/);
  });
});

describe('rule 3 — a failed read is an error, never the fallback', () => {
  it('throws read_failed when the wallet cannot be listed', async () => {
    const attempt = resolveRecoveryCoinType(failingClient(), WALLET, CONFIGURED_USDC);
    await expect(attempt).rejects.toBeInstanceOf(RecoveryCoinTypeError);
    await expect(attempt).rejects.toMatchObject({ reason: 'read_failed' });
  });

  it('throws when a later page fails, even though the first page held no stablecoin', async () => {
    const getDynamicFields = jest
      .fn()
      .mockResolvedValueOnce({ data: [SUI_BALANCE], hasNextPage: true, nextCursor: 'page-1' })
      .mockRejectedValueOnce(new Error('fetch failed'));
    const client = { getDynamicFields } as unknown as SuiClient;
    await expect(resolveRecoveryCoinType(client, WALLET, CONFIGURED_USDC)).rejects.toMatchObject({
      reason: 'read_failed',
    });
  });

  it('throws when the listing claims more pages but gives no cursor', async () => {
    const client = {
      getDynamicFields: jest.fn(async () => ({ data: [], hasNextPage: true, nextCursor: null })),
    } as unknown as SuiClient;
    await expect(readCustodyCoinHoldings(client, WALLET)).rejects.toMatchObject({ reason: 'read_failed' });
  });

  it('throws on a malformed page', async () => {
    const client = {
      getDynamicFields: jest.fn(async () => ({ hasNextPage: false, nextCursor: null })),
    } as unknown as SuiClient;
    await expect(readCustodyCoinHoldings(client, WALLET)).rejects.toMatchObject({ reason: 'read_failed' });
  });

  it('throws when the legacy field holds something that is not a Coin<T>', async () => {
    const { client } = clientWithPages([{ ...legacyCoin(USDC), objectType: `${FRAMEWORK}::kiosk::Kiosk` }]);
    await expect(resolveRecoveryCoinType(client, WALLET, CONFIGURED_USDC)).rejects.toMatchObject({
      reason: 'read_failed',
    });
  });
});

describe('holdings no single type argument can refund are refused, not guessed', () => {
  it('refuses two different stablecoins', async () => {
    const { client } = clientWithPages([typedBalance(USDC), typedBalance(OTHER_STABLE)]);
    await expect(resolveRecoveryCoinType(client, WALLET, CONFIGURED_USDC)).rejects.toMatchObject({
      reason: 'ambiguous_holdings',
    });
  });

  it('refuses a legacy SUI coin next to a stablecoin (SUI would pay the stablecoin refunds)', async () => {
    const { client } = clientWithPages([legacyCoin(SUI), typedBalance(USDC)]);
    await expect(resolveRecoveryCoinType(client, WALLET, CONFIGURED_USDC)).rejects.toMatchObject({
      reason: 'ambiguous_holdings',
    });
  });
});

describe('what the member is told', () => {
  it('says the wallet could not be read on a read failure', async () => {
    const error = await resolveRecoveryCoinType(failingClient(), WALLET, CONFIGURED_USDC).catch((e) => e);
    expect(recoveryCoinTypeErrorMessage(error)).toMatch(/couldn't read the circle's wallet/i);
    expect(recoveryCoinTypeErrorMessage(error)).toMatch(/nothing was sent/i);
  });

  it('points ambiguous holdings at support and anything else at a retry', () => {
    expect(
      recoveryCoinTypeErrorMessage(new RecoveryCoinTypeError('ambiguous_holdings', 'two stablecoins')),
    ).toMatch(/contact support/i);
    expect(recoveryCoinTypeErrorMessage(new Error('boom'))).toMatch(/try again/i);
  });
});

describe('the recovery controls use this rule', () => {
  const circlePage = readFileSync(join(process.cwd(), 'src/pages/circle/[id]/index.tsx'), 'utf8');
  const managePage = readFileSync(join(process.cwd(), 'src/pages/circle/[id]/manage/index.tsx'), 'utf8');

  it('the circle page no longer dead-ends on a wallet without stablecoin', () => {
    expect(circlePage).not.toContain('Stablecoin type is unavailable');
    expect(circlePage).toContain('resolveRecoveryCoinType');
    expect(circlePage).toContain('getCurrentCoinTypes().USDC');
  });

  it('the manage page reads the wallet instead of defaulting to the display coin', () => {
    expect(managePage).toContain('resolveRecoveryCoinType');
    expect(managePage).not.toMatch(/stablecoinType:\s*String\(extraBody\.stablecoinType \|\| recoveryStablecoinMeta/);
  });
});
