# Coinbase Onramp Architecture and Scope (Task 1)

Date: 2026-02-21
Status: Draft complete, pending product sign-off
Task Tag: coinbase-onramp
Task: 1 - Define Coinbase Onramp Architecture and Scope

## 1. Current MoonPay UX and Code Entry Points

### Dashboard buy entry points
- Wallet card primary buy action calls `openMoonPayWidget("usdc")` in `src/pages/dashboard.tsx:4889`.
- Token-row buy action exists only for `SUI` and `USDC`; button calls `openMoonPayWidget(coin.symbol.toLowerCase())` in `src/pages/dashboard.tsx:4945`.

### MoonPay launch mechanics
- MoonPay local state:
  - `isMoonPayVisible` in `src/pages/dashboard.tsx:1159`
  - `moonPayCurrency` in `src/pages/dashboard.tsx:1160`
- Launcher function sets currency + opens overlay in `src/pages/dashboard.tsx:1253`.
- Overlay render is `MoonPayWrapper` in `src/pages/dashboard.tsx:6550` with:
  - `baseCurrencyCode="usd"`
  - `baseCurrencyAmount="50"`
  - `defaultCurrencyCode={moonPayCurrency}`
  - `walletAddress={userAddress || undefined}`
- Global provider wrapper is in `src/pages/_app.tsx:94` using `NEXT_PUBLIC_MOONPAY_API_KEY`.

### Implication for Coinbase migration
- We already have two concrete UX launch points to preserve exactly:
  - wallet-level Buy Crypto button
  - token-row Buy button
- Migration should swap provider logic behind these existing buttons, not redesign placement.

## 2. Coinbase Product Mode to Lock

Use Hosted Coinbase Onramp with server-side secure initialization.

### Why this mode
- Keeps CDP credentials server-side.
- Matches current UX (single click from dashboard, then hosted checkout).
- Supports non-crypto-native users with minimal in-app complexity.

### Flow
1. Client requests app backend for eligibility/options.
2. Client requests backend session token for selected intent.
3. Backend signs Coinbase request with server credentials and returns short-lived session data.
4. Client opens Coinbase hosted flow with that session.
5. If Coinbase is unavailable/ineligible, fall back to MoonPay.

## 3. Locked Asset and Network Scope

Initial scope is strictly limited to:
- `SUI` on `Sui`
- `USDC` on `Sui`

Everything else is out of scope and must be rejected by backend normalization.

### Canonical asset intent enum (app-level)
- `SUI`
- `USDC_ON_SUI`

### Enforcement rules
- Reject any non-Sui network in options/session resolution.
- Reject any asset other than SUI and USDC when network is Sui.
- Reject direct client attempts to pass arbitrary asset/network values.

## 4. Initial Regions and Eligibility Rules

### Phase 1 rollout region
- Start with `US` only.

Reason:
- Simplest compliance and support surface for first release.
- Minimizes failure modes while replacing existing provider path.

### Eligibility checks (server-driven)
- Required context:
  - `country` (ISO-3166-1 alpha-2)
  - `subdivision` for US state when available
  - `walletAddress` (Sui address)
- A request is eligible only if Coinbase options indicate:
  - selected intent is available (`SUI` or `USDC_ON_SUI`)
  - network is Sui
  - at least one supported payment method exists

### Non-crypto-native UX rule
- If not eligible, do not hard-fail buy flow.
- Show clear message and route user to MoonPay fallback.

### Confirmed defaults (2026-02-21)
- Phase 1 launch region: `US` only.
- Wallet-level Buy Crypto default intent: `USDC_ON_SUI`.
- `SUI` remains available via token-row Buy action (explicit intent).

## 5. Provider Flag and Fallback Strategy

### Flags
- `NEXT_PUBLIC_ONRAMP_PROVIDER=auto|coinbase|moonpay` (recommended default: `auto`)
- `NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED=true|false` (kill switch, default `false` until rollout)

### Provider resolution
1. If Coinbase disabled: use MoonPay.
2. If provider is `moonpay`: use MoonPay.
3. If provider is `coinbase` or `auto`:
  - check Coinbase eligibility/options
  - if eligible, use Coinbase
  - if not eligible or API fails, use MoonPay

### Rollout
- Stage 0: `moonpay` hard default (current).
- Stage 1: enable Coinbase for internal/staging users in `auto`.
- Stage 2: production `auto` with MoonPay fallback retained.
- Stage 3: optionally move to `coinbase` default after metrics are stable.

## 6. Backend API Contract (Task 2 and Task 3 Input)

### `GET /api/onramp/coinbase/options`
Purpose: eligibility + normalized supported intents.

Request query:
- `walletAddress` (required)
- `country` (optional, server can infer if absent)
- `subdivision` (optional)

Success response example:
```json
{
  "provider": "coinbase",
  "eligible": true,
  "supportedIntents": ["SUI", "USDC_ON_SUI"],
  "paymentMethods": ["CARD"],
  "fallbackProvider": null
}
```

Fallback response example:
```json
{
  "provider": "coinbase",
  "eligible": false,
  "supportedIntents": [],
  "paymentMethods": [],
  "fallbackProvider": "moonpay",
  "reasonCode": "UNSUPPORTED_REGION_OR_ASSET"
}
```

### `POST /api/onramp/coinbase/session`
Purpose: create secure Coinbase session for one intent.

Request body:
```json
{
  "walletAddress": "0x...",
  "preferredAssetIntent": "SUI",
  "fiatAmount": 50,
  "fiatCurrency": "USD",
  "country": "US",
  "subdivision": "CA"
}
```

Validation rules:
- `walletAddress` must be valid Sui address.
- `preferredAssetIntent` must be `SUI` or `USDC_ON_SUI`.
- non-USD fiat handling is out of scope for phase 1.

Success response example:
```json
{
  "provider": "coinbase",
  "sessionToken": "<token>",
  "expiresAt": "2026-02-21T20:00:00.000Z",
  "assetIntent": "SUI"
}
```

Error response example:
```json
{
  "error": "COINBASE_UNAVAILABLE",
  "message": "Coinbase is temporarily unavailable",
  "fallbackProvider": "moonpay"
}
```

## 7. Required Env Vars and Secrets Checklist

### Existing (already used)
- `NEXT_PUBLIC_MOONPAY_API_KEY` (client fallback path)
- `MOONPAY_SECRET_KEY` (server-side, existing integration)

### New for Coinbase phase
- `CDP_API_KEY_ID` (server)
- `CDP_API_KEY_SECRET` (server, multiline/private key; never exposed client-side)
- `COINBASE_ONRAMP_API_BASE_URL` (server, default `https://api.developer.coinbase.com`)
- `NEXT_PUBLIC_ONRAMP_PROVIDER` (client/provider strategy)
- `NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED` (client kill switch)

### Future phase (webhooks/callbacks)
- `COINBASE_ONRAMP_WEBHOOK_SECRET`

### Security requirements
- Never return API keys/private key material to client.
- Redact sensitive fields from logs.
- Keep all Coinbase credential usage in API routes/service layer only.

## 8. Product Decisions (Confirmed)

- Confirmed `US`-only for phase 1 launch.
- Confirmed wallet-level default buy intent is `USDC_ON_SUI`.
- Confirmed `SUI` remains supported via explicit token-row buy actions.
- Confirmed production provider mode default: `NEXT_PUBLIC_ONRAMP_PROVIDER=auto`.

## 9. Task 1 Exit Criteria Mapping

- MoonPay current flow documented with code references: complete.
- Coinbase mode and asset/network scope locked: complete.
- Initial region + eligibility policy defined: complete (US-only phase 1).
- Provider flag and fallback strategy defined: complete.
- Implementation note with env/secrets and contracts produced: complete (this document).

## 10. Operational Follow-up Docs

- Setup and operations: `docs/coinbase-onramp-setup-operations.md`
- Staging UAT and rollout checklist: `docs/coinbase-onramp-staging-rollout-checklist.md`
