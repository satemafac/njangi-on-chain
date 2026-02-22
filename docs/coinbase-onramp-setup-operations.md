# Coinbase Onramp Setup and Operations Guide

Date: 2026-02-22  
Owner: Njangi engineering  
Scope: Coinbase hosted onramp integration for SUI and USDC on Sui with MoonPay fallback

## 1. Integration Summary

The app uses hosted Coinbase checkout and keeps all sensitive CDP credentials server-side.

Entry flow:
1. `dashboard` buy click chooses provider (`auto`/`coinbase`/`moonpay`).
2. Coinbase path calls `GET /api/onramp/coinbase/options`.
3. If eligible, client calls `POST /api/onramp/coinbase/session`.
4. Hosted Coinbase checkout opens in a new window.
5. If unavailable/ineligible, fallback is MoonPay.

## 2. Required Environment Variables

### Server-only

| Variable | Required | Purpose |
|---|---|---|
| `CDP_API_KEY_ID` | Yes | Coinbase CDP API key identifier used to sign backend calls. |
| `CDP_API_KEY_SECRET` | Yes | Coinbase CDP private key/secret used for JWT signing. |
| `COINBASE_ONRAMP_ALLOWED_ORIGINS` | Yes | Comma-separated origin allowlist for onramp API routes. |
| `COINBASE_ONRAMP_WEBHOOK_SECRET` | Yes (if webhook enabled) | Signature verification secret for Coinbase webhook route. |
| `COINBASE_ONRAMP_API_BASE_URL` | Optional | Defaults to `https://api.developer.coinbase.com`. |
| `COINBASE_ONRAMP_JWT_EXPIRES_IN_SECONDS` | Optional | JWT expiry tuning. Default is 120s. |
| `COINBASE_ONRAMP_REQUEST_TIMEOUT_MS` | Optional | Coinbase upstream timeout. Default is 10000ms. |

### Client-exposed

| Variable | Required | Purpose |
|---|---|---|
| `NEXT_PUBLIC_ONRAMP_PROVIDER` | Yes | `auto`, `coinbase`, or `moonpay`. |
| `NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED` | Yes | Coinbase kill-switch (`true`/`false`). |
| `NEXT_PUBLIC_MOONPAY_API_KEY` | Yes | MoonPay fallback path. |

## 3. Coinbase Dashboard Setup

1. Create or select CDP project in Coinbase Developer Platform.
2. Generate API key and secret:
   - Store key ID as `CDP_API_KEY_ID`.
   - Store key secret as `CDP_API_KEY_SECRET`.
3. Configure domain/origin allowlist in your environment:
   - Add production and staging origins to `COINBASE_ONRAMP_ALLOWED_ORIGINS`.
4. Configure webhook secret in Coinbase and store in `COINBASE_ONRAMP_WEBHOOK_SECRET`.
5. Keep secrets server-only. Never expose CDP secrets to client code.

## 4. API Route Reference

### `GET /api/onramp/coinbase/options`

Purpose: eligibility and supported intents (`SUI`, `USDC_ON_SUI`) for a wallet and region.

Query:
- `walletAddress` (required, Sui format)
- `country` (optional, defaults/inferred, currently US-only logic)
- `subdivision` (optional)

Success response keys:
- `eligible`
- `supportedIntents`
- `supportedAssets`
- `paymentMethods`
- `fallbackProvider`

Common errors:
- `VALIDATION_ERROR` (`400`)
- `RATE_LIMITED` (`429`)
- `CORS_FORBIDDEN` (`403`)
- `COINBASE_TIMEOUT`/other upstream errors (`5xx`)

### `POST /api/onramp/coinbase/session`

Purpose: create short-lived hosted checkout session token.

Body:
- `walletAddress`
- `preferredAssetIntent` (`SUI` or `USDC_ON_SUI`)
- `country` (`US` for phase 1)
- optional `fiatAmount`, `fiatCurrency`, `subdivision`

Success response keys:
- `token`
- `channelId` (if provided by Coinbase)
- `assetIntent`

Common errors:
- `VALIDATION_ERROR` (`400`)
- `UNSUPPORTED_REGION` (`400`)
- `RATE_LIMITED` (`429`)
- Coinbase upstream mapped errors (`5xx`)

### `GET /api/onramp/coinbase/callback`

Purpose: normalize return parameters from hosted flow and provide a clean callback payload for frontend state updates.

### `POST /api/onramp/coinbase/webhook`

Purpose: receive asynchronous Coinbase event updates with signature verification and idempotency handling.

## 5. Rate Limits and Abuse Controls

Current enforced limits:

### Session endpoint
- IP per minute: 10
- IP per day: 400
- Wallet per minute: 20
- Wallet per day: 100

### Options endpoint
- IP per minute: 20
- IP per day: 800
- Wallet per minute: 40
- Wallet per day: 200

When exceeded:
- Status `429`
- `Retry-After` header returned
- `RATE_LIMITED` error payload

## 6. Logging, Correlation, and Redaction

All Coinbase onramp API routes emit structured JSON logs with:
- `correlationId`
- endpoint and request method/path
- event name
- redacted metadata

Headers:
- Incoming accepted: `X-Correlation-Id`, `X-Request-Id`
- Outgoing exposed: `X-Correlation-Id`

Redaction policy:
- Masks wallet addresses
- Redacts keys matching secret/token/signature/api-key patterns
- Truncates long string payloads

## 7. Troubleshooting Playbook

### `MISSING_COINBASE_CREDENTIALS`
- Check `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET`.
- Confirm values are available in server runtime (not client-only).

### `UNSUPPORTED_REGION`
- Confirm request country is `US`.
- Verify geolocation headers or explicit query/body country.

### `VALIDATION_ERROR`
- Verify wallet format (`0x` + hex, up to 64 chars).
- Check asset intent only uses `SUI` or `USDC_ON_SUI`.

### `RATE_LIMITED`
- Backoff and retry after `Retry-After`.
- Confirm no client-side retry storms.
- Check abuse logs using `correlationId`.

### `COINBASE_TIMEOUT` or `COINBASE_NETWORK_ERROR`
- Confirm outbound network from server is healthy.
- Consider raising `COINBASE_ONRAMP_REQUEST_TIMEOUT_MS` moderately.
- Verify Coinbase API status.

### Popup blocked in frontend
- Browser blocked new window.
- Prompt user to allow popups and retry.

## 8. Operational Guardrails

Before enabling Coinbase in production:
1. Keep `NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED=false` until signoff.
2. Validate API route responses from staging with real environment values.
3. Confirm logs include correlation IDs and no secrets.
4. Keep MoonPay fallback active.

