/**
 * Coins are known by exact type: SUI (9 decimals) and the network's USDC
 * (6 decimals). Everything else is unsupported, and nothing is scaled with a
 * guessed number of decimals.
 */
import {
  classifyCoinType,
  formatBaseUnits,
  formatBaseUnitsForDisplay,
  formatCoinAmount,
  normalizeCoinType,
  parseCoinAmount,
  resolveSupportedCoin,
  supportedCoinBySymbol,
  supportedCoins,
  toBaseUnitsTruncated,
} from '@/lib/supported-coins';

const USDC = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';
const SUI_LONG = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
// An escrow snapshot's asset_type is type_name::into_string: no 0x.
const SUI_AS_TYPE_NAME = SUI_LONG.slice(2);
const USDC_AS_TYPE_NAME = USDC.slice(2);
const LOOKALIKE_USDC = `0x${'ba'.repeat(32)}::usdc::USDC`;

describe('supported coins', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.NEXT_PUBLIC_TESTNET_USDC;
    delete process.env.NEXT_PUBLIC_TESTNET_USDC;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_TESTNET_USDC;
    else process.env.NEXT_PUBLIC_TESTNET_USDC = saved;
  });

  it('are SUI and the network USDC, with their real decimals', () => {
    expect(supportedCoins('testnet')).toEqual([
      { symbol: 'SUI', coinType: '0x2::sui::SUI', decimals: 9 },
      { symbol: 'USDC', coinType: USDC, decimals: 6 },
    ]);
    expect(supportedCoinBySymbol('USDC', 'testnet')?.coinType).toBe(USDC);
  });

  it('resolve every spelling of the same type, including the escrow snapshot form', () => {
    for (const sui of ['0x2::sui::SUI', SUI_LONG, SUI_AS_TYPE_NAME, ` ${SUI_LONG} `]) {
      expect(resolveSupportedCoin(sui, 'testnet')).toEqual({ symbol: 'SUI', coinType: '0x2::sui::SUI', decimals: 9 });
    }
    for (const usdc of [USDC, USDC_AS_TYPE_NAME, USDC.toUpperCase().replace('0X', '0x').replace('::USDC::USDC', '::usdc::USDC')]) {
      expect(resolveSupportedCoin(usdc, 'testnet')).toEqual({ symbol: 'USDC', coinType: USDC, decimals: 6 });
    }
  });

  it('never match a coin by its struct name alone', () => {
    expect(resolveSupportedCoin(LOOKALIKE_USDC, 'testnet')).toBeNull();
    expect(resolveSupportedCoin(`0x${'ab'.repeat(32)}::sui::SUI`, 'testnet')).toBeNull();
    expect(resolveSupportedCoin('USDC', 'testnet')).toBeNull();
    // Mainnet USDC is not testnet USDC.
    expect(resolveSupportedCoin(USDC, 'mainnet')).toBeNull();
  });

  it('leave USDC out when its configured type is not a coin type, rather than sign with it', () => {
    process.env.NEXT_PUBLIC_TESTNET_USDC = '0xyour_testnet_usdc_type';
    expect(supportedCoins('testnet').map((coin) => coin.symbol)).toEqual(['SUI']);
    expect(resolveSupportedCoin(USDC, 'testnet')).toBeNull();
  });

  it('classify a read as supported, unsupported or unknown', () => {
    expect(classifyCoinType(USDC_AS_TYPE_NAME, 'testnet')).toEqual({
      kind: 'supported',
      coin: { symbol: 'USDC', coinType: USDC, decimals: 6 },
    });
    expect(classifyCoinType(LOOKALIKE_USDC, 'testnet')).toEqual({
      kind: 'unsupported',
      coinType: LOOKALIKE_USDC,
    });
    for (const unreadable of ['', '   ', undefined, null, 42, 'not a type', `${USDC}<u8>`]) {
      expect(classifyCoinType(unreadable, 'testnet')).toEqual({ kind: 'unknown' });
    }
  });

  it('normalize to the full 0x form', () => {
    expect(normalizeCoinType('0x2::sui::SUI')).toBe(SUI_LONG);
    expect(normalizeCoinType('0xzz::sui::SUI')).toBeNull();
  });
});

describe('formatBaseUnits / formatCoinAmount', () => {
  it('formats exactly, trimming trailing zeros', () => {
    expect(formatBaseUnits('300000', 6)).toBe('0.3');
    expect(formatBaseUnits(1_500_000_000n, 9)).toBe('1.5');
    expect(formatBaseUnits('0', 6)).toBe('0');
    expect(formatBaseUnits('25000000', 6)).toBe('25');
    expect(formatBaseUnits('123456789012345678901234567890', 9)).toBe('123456789012345678901.23456789');
  });

  it('cuts the fraction to maxFractionDigits without rounding up', () => {
    expect(formatBaseUnits('1999999', 6, 2)).toBe('1.99');
    expect(formatBaseUnits('1000001', 6, 2)).toBe('1');
  });

  it('is null for anything that is not a base-unit amount', () => {
    for (const bad of ['', '-5', '1.5', 'abc', ' ']) expect(formatBaseUnits(bad, 6)).toBeNull();
    expect(formatBaseUnits(-1n, 6)).toBeNull();
  });

  it('labels the amount with the coin', () => {
    expect(formatCoinAmount('300000', { symbol: 'USDC', decimals: 6 })).toBe('0.3 USDC');
    expect(formatCoinAmount('300000', { symbol: 'SUI', decimals: 9 })).toBe('0.0003 SUI');
    expect(formatCoinAmount('x', { symbol: 'SUI', decimals: 9 })).toBeNull();
  });
});

describe('parseCoinAmount', () => {
  it('converts a typed amount to base units exactly', () => {
    expect(parseCoinAmount('0.29', 6)).toBe(290_000n);
    expect(parseCoinAmount('1', 6)).toBe(1_000_000n);
    expect(parseCoinAmount('.5', 6)).toBe(500_000n);
    expect(parseCoinAmount('5.', 9)).toBe(5_000_000_000n);
    expect(parseCoinAmount(' 00.10 ', 6)).toBe(100_000n);
    expect(parseCoinAmount('0.000000001', 9)).toBe(1n);
  });

  it('refuses more fraction digits than the coin has, rather than dropping them', () => {
    expect(parseCoinAmount('1.1234567', 6)).toBeNull();
    expect(parseCoinAmount('0.0000000001', 9)).toBeNull();
  });

  it('refuses anything that is not a plain non-negative decimal', () => {
    for (const bad of ['', '.', '-1', '1e3', 'abc', '1,000', '1.2.3', '+1']) {
      expect(parseCoinAmount(bad, 6)).toBeNull();
    }
  });
});

describe('formatBaseUnitsForDisplay', () => {
  it('shows a nonzero amount below the display precision as "< 0.0001", never "0"', () => {
    expect(formatBaseUnitsForDisplay('50000', 9, 4)).toBe('< 0.0001');
    expect(formatBaseUnitsForDisplay(1n, 6, 2)).toBe('< 0.01');
    expect(formatBaseUnitsForDisplay('1', 6, 0)).toBe('< 1');
  });

  it('formats everything else as formatBaseUnits does', () => {
    expect(formatBaseUnitsForDisplay('0', 9, 4)).toBe('0');
    expect(formatBaseUnitsForDisplay('150000000', 9, 4)).toBe('0.15');
    expect(formatBaseUnitsForDisplay('100000', 9, 4)).toBe('0.0001');
    expect(formatBaseUnitsForDisplay('x', 9, 4)).toBeNull();
  });
});

describe('toBaseUnitsTruncated', () => {
  it('converts computed amounts exactly: a 0.29 share is 290000 units, not 289999', () => {
    expect(toBaseUnitsTruncated(0.29, 6)).toBe(290_000n);
    expect(toBaseUnitsTruncated('0.29', 6)).toBe(290_000n);
    expect(toBaseUnitsTruncated(1.5, 9)).toBe(1_500_000_000n);
  });

  it('cuts digits beyond the coin, never rounding up', () => {
    expect(toBaseUnitsTruncated('0.1234567891234', 9)).toBe(123_456_789n);
    expect(toBaseUnitsTruncated(0.1234567899, 9)).toBe(123_456_789n);
    expect(toBaseUnitsTruncated('1.9999999', 6)).toBe(1_999_999n);
  });

  it('reads numbers that print in exponent notation', () => {
    expect(toBaseUnitsTruncated(1e-7, 9)).toBe(100n);
    expect(toBaseUnitsTruncated(5e-7, 6)).toBe(0n);
  });

  it('is null for anything that is not a finite non-negative amount', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, '-1', 'abc', '', '1e-7', '1.2.3']) {
      expect(toBaseUnitsTruncated(bad, 9)).toBeNull();
    }
  });
});
