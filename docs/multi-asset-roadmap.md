# Multi-asset roadmap: BTC and later coins

_2026-10-04. Owner decision: **the MVP supports SUI and USDC only.** BTC and
other coins are post-MVP. This page records what we'd support next, why, and
what has to be true before we do._

## MVP (now)

- **USDC** (native Circle USDC on Sui) is the savings and settlement coin.
- **SUI** is the alternate mode and the gas coin.
- See [`cex-transfer-asset-strategy.md`](cex-transfer-asset-strategy.md) for
  the funding model (direct exchange transfers on the Sui network).

## Next: BTC-denominated circles

**Recommended: OKX xBTC**, coin type
`0x876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50::xbtc::XBTC`
(8 decimals; checked on chain 2026-10-04).

- It's the only BTC a major exchange lets users withdraw directly on the Sui
  network. OKX converts BTC to xBTC on withdrawal and back 1:1 on deposit.
  Binance, Coinbase, Kraken, KuCoin, Bitget, Gate and HTX offer no BTC on Sui.
- It earns no yield and uses no bridge.
- It's the largest actively traded BTC float on Sui (about 330 BTC).
- Members who use other exchanges would fund with USDC and swap in the app
  through an aggregator; Cetus's direct xBTC/USDC pool is thin.
- **Risks:** OKX is the sole custodian and can freeze or pause xBTC (as Circle
  can with USDC); it's not available in every jurisdiction; it's a single
  exchange rail.

**Runner-up: BitGo WBTC** (LayerZero OFT,
`0x0041f9f9344cac094454cd574e333c4fdb132d7bcc9379bcd4aab485b2a63942::wbtc::WBTC`).
It has the best Cetus USDC pool, but no exchange withdraws it on Sui, and its
cross-chain setup may change.

**Not eligible:** yield-bearing or liquid-staked BTC (LBTC, WLBTC, stBTC,
svBTC). Holding them in a circle would pay yield, which compliance invariant
#4 rules out unless counsel approves first. Copycat tokens exist, so always pin
the exact coin type.

**Testnet:** no xBTC exists there; we'd publish our own 8-decimal test coin.

**Display price:** Supra's on-chain feed (pair 18, BTC/USD). Prices are for
display only, never for amounts members owe.

## Prerequisites before any new coin ships

1. **v11 contract upgrade.** Each circle pins its coin, decimals and amounts on
   chain; deposits use the circle's own coin; emergency refunds run per coin.
   After v11, adding a coin is a registry entry plus app configuration, with no
   contract publish.
2. **8-decimal support** in the contract and app (today's helpers handle 6 and 9).
3. **Counsel.** The July asset strategy treated BTC only as a swap-in asset, not
   a savings currency. BTC circles need counsel's sign-off, and updated Terms and
   Risk Disclosure text. That's a legal-version bump, which re-prompts every user.
4. **Funding and copy:** exchange-withdrawal instructions for the coin, and FAQ
   updates ("Two: USDC and SUI" today).

## Later coins

Same path as BTC: the coin must be withdrawable on the Sui network from major
exchanges, earn no yield, have enough liquidity, and pass counsel. Each one is
then a registry entry plus app configuration.
