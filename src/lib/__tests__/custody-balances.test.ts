/**
 * The manage page's custody balances. Its first load read
 * `CustodyWallet.balance` only in the nested `{ fields: { value } }` form, so
 * it showed 0 whenever the RPC returned the plain string, and both of its
 * paths counted SUI security deposits only as legacy `Coin<SUI>` objects.
 * Deposits are typed `dynamic_field<String, Balance<T>>` fields, SUI
 * included. readCustodyBalances reads all of it, and a failed read throws
 * instead of reading as zero.
 */
import type { SuiClient } from '@mysten/sui/client';
import { readCustodyBalances } from '@/lib/custody-wallet-balance';

const WALLET = '0xwallet';
const USDC = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';
const LOOKALIKE = `0x${'ba'.repeat(32)}::usdc::USDC`;
const SUI_NAME = '0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

type Entry = Record<string, unknown>;

function typedField(id: string, coinType: string, name: string): Entry {
  return {
    type: 'DynamicField',
    objectId: id,
    objectType: `0x2::balance::Balance<${coinType}>`,
    name: { type: '0x1::string::String', value: name },
  };
}

function fakeClient(opts: {
  walletBalance: unknown;
  pages: Entry[][];
  objects: Record<string, Record<string, unknown> | 'throw' | 'empty'>;
}): Pick<SuiClient, 'getObject' | 'getDynamicFields'> {
  return {
    getObject: jest.fn(async ({ id }: { id: string }) => {
      if (id === WALLET) {
        return { data: { content: { dataType: 'moveObject', fields: { balance: opts.walletBalance } } } };
      }
      const fields = opts.objects[id];
      if (fields === 'throw') throw new Error('429');
      if (fields === undefined || fields === 'empty') return { data: null };
      return { data: { content: { dataType: 'moveObject', fields } } };
    }),
    getDynamicFields: jest.fn(async ({ cursor }: { cursor?: string | null }) => {
      const index = cursor ? Number(cursor) : 0;
      return {
        data: opts.pages[index] ?? [],
        hasNextPage: index + 1 < opts.pages.length,
        nextCursor: index + 1 < opts.pages.length ? String(index + 1) : null,
      };
    }),
  } as unknown as Pick<SuiClient, 'getObject' | 'getDynamicFields'>;
}

describe('readCustodyBalances', () => {
  it('reads the plain-string main balance, typed SUI and USDC deposits, and legacy coins', async () => {
    const client = fakeClient({
      walletBalance: '7',
      pages: [
        [
          typedField('0xsui', '0x2::sui::SUI', SUI_NAME),
          typedField('0xusdc', USDC, USDC.slice(2)),
        ],
        [
          typedField('0xlookalike', LOOKALIKE, LOOKALIKE.slice(2)),
          { type: 'DynamicObject', objectId: '0xlegacy', objectType: '0x2::coin::Coin<0x2::sui::SUI>', name: { type: '0x1::string::String', value: 'coin_objects' } },
        ],
      ],
      objects: {
        '0xsui': { value: '25000000000' },
        '0xusdc': { value: '30000000' },
        '0xlookalike': { value: '999' },
        '0xlegacy': { balance: '5' },
      },
    });

    await expect(readCustodyBalances(client, WALLET, USDC)).resolves.toEqual({
      suiMain: 7n,
      suiDeposits: 25_000_000_005n,
      usdc: 30_000_000n,
    });
  });

  it('still reads the nested main-balance form', async () => {
    const client = fakeClient({ walletBalance: { fields: { value: '42' } }, pages: [[]], objects: {} });
    await expect(readCustodyBalances(client, WALLET, USDC)).resolves.toEqual({
      suiMain: 42n,
      suiDeposits: 0n,
      usdc: 0n,
    });
  });

  it('ignores a typed balance stored under another name', async () => {
    const client = fakeClient({
      walletBalance: '0',
      pages: [[typedField('0xodd', USDC, 'something_else')]],
      objects: { '0xodd': { value: '1' } },
    });
    await expect(readCustodyBalances(client, WALLET, USDC)).resolves.toMatchObject({ usdc: 0n });
  });

  it('throws, never reads zero USDC, when the USDC type is unconfigured or malformed', async () => {
    const client = fakeClient({
      walletBalance: '0',
      pages: [[typedField('0xusdc', USDC, USDC.slice(2))]],
      objects: { '0xusdc': { value: '30000000' } },
    });
    for (const unconfigured of ['', '0xyour_testnet_usdc_type', 'USDC']) {
      await expect(readCustodyBalances(client, WALLET, unconfigured)).rejects.toThrow(/USDC coin type/);
    }
    expect(client.getObject).not.toHaveBeenCalled();
  });

  it('throws, never reads zero, when a read fails or does not parse', async () => {
    const pages = [[typedField('0xusdc', USDC, USDC.slice(2))]];
    await expect(
      readCustodyBalances(fakeClient({ walletBalance: '0', pages, objects: { '0xusdc': 'throw' } }), WALLET, USDC),
    ).rejects.toThrow('429');
    await expect(
      readCustodyBalances(fakeClient({ walletBalance: '0', pages, objects: { '0xusdc': 'empty' } }), WALLET, USDC),
    ).rejects.toThrow(/did not read as a balance/);
    await expect(
      readCustodyBalances(fakeClient({ walletBalance: undefined, pages: [[]], objects: {} }), WALLET, USDC),
    ).rejects.toThrow(/did not read/);
  });
});
