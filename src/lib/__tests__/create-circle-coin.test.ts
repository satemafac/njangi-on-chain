import * as fs from 'fs';
import * as path from 'path';

import {
  canPickSui,
  DEFAULT_CREATE_CIRCLE_COIN,
  formatCreateCoinAmount,
  settlementAssetForCreate,
} from '../create-circle-coin';

describe('settlementAssetForCreate', () => {
  it('sends SUI only when the organizer picked it', () => {
    expect(settlementAssetForCreate('SUI')).toBe('SUI');
    expect(settlementAssetForCreate('USDC')).toBe('USDC');
  });

  it('defaults to USDC, including a form saved before the choice existed', () => {
    expect(DEFAULT_CREATE_CIRCLE_COIN).toBe('USDC');
    expect(settlementAssetForCreate(undefined)).toBe('USDC');
    expect(settlementAssetForCreate('sui')).toBe('USDC');
    expect(settlementAssetForCreate(null)).toBe('USDC');
  });
});

describe('canPickSui', () => {
  it('needs a SUI price, since the SUI amounts are priced from it', () => {
    expect(canPickSui(true)).toBe(true);
    expect(canPickSui(false)).toBe(false);
  });
});

describe('formatCreateCoinAmount', () => {
  it('shows the whole cents a USDC circle stores', () => {
    expect(formatCreateCoinAmount({ coin: 'USDC', usd: 0.1, sui: 0.0847 })).toBe('0.10 USDC');
    expect(formatCreateCoinAmount({ coin: 'USDC', usd: 12.349, sui: 0 })).toBe('12.34 USDC');
  });

  it('shows up to four decimals of SUI', () => {
    expect(formatCreateCoinAmount({ coin: 'SUI', usd: 0.1, sui: 0.08474576 })).toBe('0.0847 SUI');
    expect(formatCreateCoinAmount({ coin: 'SUI', usd: 10, sui: 8.5 })).toBe('8.5 SUI');
    expect(formatCreateCoinAmount({ coin: 'SUI', usd: 10, sui: 12 })).toBe('12 SUI');
  });

  it('never prints a negative or non-numeric amount', () => {
    expect(formatCreateCoinAmount({ coin: 'SUI', usd: 0, sui: Number.NaN })).toBe('0 SUI');
    expect(formatCreateCoinAmount({ coin: 'USDC', usd: -1, sui: 0 })).toBe('0.00 USDC');
  });
});

describe('the create form sends the chosen coin', () => {
  // The page is a .tsx module jest does not load; read its source instead,
  // the way the round panel's guards are checked.
  const page = fs.readFileSync(
    path.join(__dirname, '..', '..', 'pages', 'create-circle.tsx'),
    'utf8',
  );

  it('puts settlement_asset from the form into the create data', () => {
    expect(page).toContain('settlement_asset: isSmartGoal ? DEFAULT_CREATE_CIRCLE_COIN : settlementAssetForCreate(formData.settlementAsset)');
  });

  it('no longer tells organizers to switch the coin on the manage page', () => {
    expect(page).not.toMatch(/switch (?:the circle|it) to SUI/i);
    expect(page).not.toMatch(/switch it on the manage page/i);
  });

  // The price service never returns null — when every source is down it
  // hands out a hardcoded 3.71 — so "price !== null" let SUI circles be
  // pinned to a number nobody quoted (sui-price-reading.ts).
  it('gates SUI on a usable quote, never on the price merely existing', () => {
    expect(page).toContain('setIsPriceAvailable(isUsableSuiPrice(reading))');
    expect(page).not.toContain('setIsPriceAvailable(price !== null)');
  });

  it('refuses to submit a SUI circle without a usable quote, and lets USDC through', () => {
    expect(page).toContain("if (circleCoin === 'SUI' && !isPriceAvailable) {");
    expect(page).not.toMatch(/^\s*if \(!isPriceAvailable\) \{\s*$/m);
  });

  it("shows a stale quote its age instead of calling it today's price", () => {
    expect(page).toContain("t('create.coinHintSuiStale', { age: formatSuiPriceAge(suiPriceStaleAge) })");
  });

  it('re-converts the SUI amounts when the price changes, so a fallback never lingers in them', () => {
    expect(page).toContain('}, [formData.selectedCurrency, suiPrice]);');
  });
});
