// create-circle-coin.ts — the coin a new circle's members pay in.
//
// Since package v11 a circle's coin is pinned when it is created
// (`create_circle_with_asset<T>`), and its manage page cannot switch it
// afterwards. The create form used to send no coin at all, so every circle
// came out USDC while the form still told organizers they could switch to
// SUI on the manage page later. The choice now happens here, once.
//
// USDC pins the US-dollar amount at the peg. SUI pins the SUI amount the
// form priced at today's rate, which is why SUI can only be picked while a
// SUI price is available.

export type CreateCircleCoin = 'USDC' | 'SUI';

export const DEFAULT_CREATE_CIRCLE_COIN: CreateCircleCoin = 'USDC';

/**
 * The `settlement_asset` sent to `create_circle_with_asset`: SUI only when
 * the organizer picked it, USDC otherwise (including a saved form from
 * before this choice existed).
 */
export function settlementAssetForCreate(coin: unknown): CreateCircleCoin {
  return coin === 'SUI' ? 'SUI' : DEFAULT_CREATE_CIRCLE_COIN;
}

/** SUI amounts come from today's price; without one there is nothing to pin. */
export function canPickSui(isPriceAvailable: boolean): boolean {
  return isPriceAvailable;
}

/**
 * An amount in the chosen coin, e.g. "0.10 USDC" or "0.0847 SUI". USDC
 * shows the whole cents the contract stores; SUI up to four decimals.
 */
export function formatCreateCoinAmount(args: {
  coin: CreateCircleCoin;
  usd: number;
  sui: number;
}): string {
  if (args.coin === 'SUI') {
    const sui = Number.isFinite(args.sui) && args.sui > 0 ? args.sui : 0;
    const fixed = sui.toFixed(4).replace(/\.?0+$/, '');
    return `${fixed || '0'} SUI`;
  }
  const usd = Number.isFinite(args.usd) && args.usd > 0 ? args.usd : 0;
  return `${(Math.floor(usd * 100) / 100).toFixed(2)} USDC`;
}
