/**
 * A round's calls take the round's own coin (its escrow snapshot's
 * `asset_type`), not the circle's SUI/USDC mode, which the admin can change
 * between laps. An unreadable coin type is refused, never guessed.
 */
import { readFileSync } from 'fs';
import path from 'path';
import {
  escrowCallCoin,
  escrowReleaseCoinType,
  formatEscrowAmount,
  resolveEscrowCoin,
  resolveOpenRoundCoin,
} from '@/lib/escrow-coin';

const USDC = '0x26b3bc67befc214058ca78ea9a2690298d731a2d4309485ec3d40198063c4abc::usdc::USDC';
// What an escrow snapshot holds: type_name::into_string, no 0x.
const SUI_SNAPSHOT = '0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const USDC_SNAPSHOT = USDC.slice(2);
const OTHER = `0x${'ef'.repeat(32)}::usdc::USDC`;

const SUI_COIN = { symbol: 'SUI', coinType: '0x2::sui::SUI', decimals: 9 };
const USDC_COIN = { symbol: 'USDC', coinType: USDC, decimals: 6 };

describe('resolveEscrowCoin', () => {
  it("reads the round's coin from its own snapshot, whatever the circle's mode is now", () => {
    // A USDC-mode circle whose previous lap ran in SUI: the round is SUI.
    const coin = resolveEscrowCoin({ assetType: SUI_SNAPSHOT }, null, 'testnet');
    expect(escrowCallCoin(coin)).toEqual(SUI_COIN);
    expect(escrowCallCoin(resolveEscrowCoin({ assetType: USDC_SNAPSHOT }, null, 'testnet'))).toEqual(USDC_COIN);
  });

  it('prefers the live state and falls back to the discovery summary', () => {
    expect(
      escrowCallCoin(resolveEscrowCoin({ assetType: USDC_SNAPSHOT }, { assetType: SUI_SNAPSHOT }, 'testnet')),
    ).toEqual(USDC_COIN);
    expect(escrowCallCoin(resolveEscrowCoin(null, { assetType: SUI_SNAPSHOT }, 'testnet'))).toEqual(SUI_COIN);
    expect(escrowCallCoin(resolveEscrowCoin({ assetType: '' }, { assetType: SUI_SNAPSHOT }, 'testnet'))).toEqual(
      SUI_COIN,
    );
  });

  it('is null without a round, and unknown when the type could not be read', () => {
    expect(resolveEscrowCoin(null, null, 'testnet')).toBeNull();
    expect(resolveEscrowCoin({ assetType: '' }, { assetType: '' }, 'testnet')).toEqual({ kind: 'unknown' });
    expect(resolveEscrowCoin({ assetType: 'garbage' }, null, 'testnet')).toEqual({ kind: 'unknown' });
  });
});

describe('escrowCallCoin', () => {
  it('signs payments, collects and refunds only in a supported coin', () => {
    expect(escrowCallCoin({ kind: 'unknown' })).toBeNull();
    expect(escrowCallCoin({ kind: 'unsupported', coinType: OTHER })).toBeNull();
    expect(escrowCallCoin(null)).toBeNull();
  });
});

describe('escrowReleaseCoinType', () => {
  it("releases with the released escrow's own type, supported or not, never a guessed one", () => {
    expect(escrowReleaseCoinType(resolveEscrowCoin({ assetType: SUI_SNAPSHOT }, null, 'testnet'))).toBe(
      '0x2::sui::SUI',
    );
    expect(escrowReleaseCoinType({ kind: 'unsupported', coinType: OTHER })).toBe(OTHER);
    expect(escrowReleaseCoinType({ kind: 'unknown' })).toBeNull();
    expect(escrowReleaseCoinType(null)).toBeNull();
  });
});

describe('formatEscrowAmount', () => {
  it("formats in the round's coin: a USDC share is never shown as SUI", () => {
    const usdc = resolveEscrowCoin({ assetType: USDC_SNAPSHOT }, null, 'testnet');
    expect(formatEscrowAmount('300000', usdc, 'unsupported coin')).toBe('0.3 USDC');
    const sui = resolveEscrowCoin({ assetType: SUI_SNAPSHOT }, null, 'testnet');
    expect(formatEscrowAmount('300000', sui, 'unsupported coin')).toBe('0.0003 SUI');
  });

  it('never scales an unsupported or unknown coin', () => {
    expect(formatEscrowAmount('300000', { kind: 'unsupported', coinType: OTHER }, 'unsupported coin')).toBe(
      'unsupported coin',
    );
    expect(formatEscrowAmount('300000', { kind: 'unknown' }, 'unsupported coin')).toBe('—');
  });
});

describe('resolveOpenRoundCoin', () => {
  it('opens SUI rounds plainly and USDC rounds at USDC decimals', () => {
    expect(resolveOpenRoundCoin('0x2::sui::SUI', 'testnet')).toEqual({ coin: SUI_COIN });
    expect(resolveOpenRoundCoin(USDC, 'testnet')).toEqual({ coin: USDC_COIN, stableDecimals: 6 });
  });

  it('refuses a mode coin that is not supported on the network', () => {
    expect(resolveOpenRoundCoin(OTHER, 'testnet')).toBeNull();
    expect(resolveOpenRoundCoin('', 'testnet')).toBeNull();
    expect(resolveOpenRoundCoin(USDC, 'mainnet')).toBeNull();
  });
});

describe('CycleEscrowPanel', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/components/CycleEscrowPanel.tsx'), 'utf8');

  it('takes the open coin as its only coin prop, and reads the round coin from the escrow', () => {
    expect(source).toContain('openCoin: SettlementCoin;');
    expect(source).not.toMatch(/coinType\?: string;/);
    expect(source).not.toMatch(/coinDecimals\s*=\s*9/);
    expect(source).toContain('resolveEscrowCoin(liveState, summary, network)');
  });

  it('builds no call on an existing round from the open coin', () => {
    // openCoin feeds resolveOpenRoundCoin and the open callback's
    // dependency list, and nothing else.
    expect(source.match(/openCoin\.coinType/g)).toHaveLength(2);
    expect(source).toContain('resolveOpenRoundCoin(openCoin.coinType, network)');
  });
});
