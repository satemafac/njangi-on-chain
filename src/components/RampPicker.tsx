import React, { useEffect, useMemo, useState } from 'react';
import CoinbaseOnrampLauncher, { type CoinbaseOnrampLauncherProps } from './CoinbaseOnrampLauncher';
import { MoonPayLauncher } from './MoonPayLauncher';
import { TransakLauncher } from './TransakLauncher';
import type { CoinbaseAssetIntent } from '@/types/coinbase-onramp';
import type { MoonPayBaseCurrency } from '@/services/moonpay-service';
import {
  COUNTRY_OVERRIDE_OTHER,
  RAMP_PROVIDER_LABELS,
  type RampGeoResponse,
  type RampProviderId,
  countryFromNavigatorLanguage,
  fetchRampGeo,
  fiatCurrencyForProvider,
  getStoredCountryOverride,
  orderedEnabledProviders,
  readClientProviderFlags,
  setStoredCountryOverride,
} from '@/lib/ramp-geo';

export interface RampPickerProps {
  walletAddress: string;
  preferredAssetIntent: CoinbaseAssetIntent;
  /**
   * Reference amount in USD. Only forwarded to providers that check out in
   * USD — XAF providers let the buyer price the purchase in local currency.
   */
  amountUsd?: number;
  /** Explicit ISO 3166-1 alpha-2 country. When omitted the picker detects it. */
  country?: string;
  subdivision?: string;
  email?: string;
  externalCustomerId?: string;
  className?: string;
  /** Extra props forwarded to the Coinbase launcher (providerFlag, uiVariant, ...). */
  coinbase?: Partial<CoinbaseOnrampLauncherProps>;
  /** Fired when any provider checkout opens successfully. */
  onLaunched?: (provider: RampProviderId) => void;
  /** Fired when a provider fails to create a session (before failover). */
  onProviderError?: (provider: RampProviderId, error: Error) => void;
}

const REGION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'auto', label: 'Detect automatically' },
  { value: 'CM', label: 'Cameroon (XAF)' },
  { value: 'GA', label: 'Gabon (XAF)' },
  { value: 'TD', label: 'Chad (XAF)' },
  { value: 'CF', label: 'Central African Republic (XAF)' },
  { value: 'CG', label: 'Republic of the Congo (XAF)' },
  { value: 'GQ', label: 'Equatorial Guinea (XAF)' },
  { value: 'US', label: 'United States (USD)' },
  { value: COUNTRY_OVERRIDE_OTHER, label: 'Other / International' },
];

/** Coinbase launcher errors that are user-side, not a provider outage. */
const NON_OUTAGE_COINBASE_CODES = new Set(['POPUP_BLOCKED', 'VALIDATION_ERROR']);

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'Provider is temporarily unavailable.';
}

function errorCode(error: unknown): string | null {
  if (error && typeof error === 'object') {
    const maybe = error as { code?: unknown; error?: unknown };
    if (typeof maybe.code === 'string') return maybe.code;
    if (typeof maybe.error === 'string') return maybe.error;
  }
  return null;
}

/**
 * Surfaces the available regulated on/off-ramp providers in the order most
 * appropriate for the user's geography (2026-06 GTM audit: CEMAC users get
 * the XAF-capable Transak first; Coinbase only leads in the US). Providers
 * are independently KYC-gated and licensed by their operator; Njangi is a
 * non-custodial coordinator and never settles fiat directly.
 *
 * Failover: when a provider errors during session creation it is marked
 * unavailable and the next provider in geo order is promoted, so the user
 * is never dead-ended on a single provider outage.
 */
export const RampPicker: React.FC<RampPickerProps> = ({
  walletAddress,
  preferredAssetIntent,
  amountUsd,
  country: countryProp,
  subdivision,
  email,
  externalCustomerId,
  className,
  coinbase,
  onLaunched,
  onProviderError,
}) => {
  const [geo, setGeo] = useState<RampGeoResponse | null>(null);
  const [geoChecked, setGeoChecked] = useState(false);
  const [override, setOverride] = useState<string | null>(null);
  const [overrideLoaded, setOverrideLoaded] = useState(false);
  const [failed, setFailed] = useState<Partial<Record<RampProviderId, string>>>({});

  useEffect(() => {
    setOverride(getStoredCountryOverride());
    setOverrideLoaded(true);
  }, []);

  useEffect(() => {
    let alive = true;
    fetchRampGeo()
      .then((response) => {
        if (alive) setGeo(response);
      })
      .finally(() => {
        if (alive) setGeoChecked(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const effectiveCountry = useMemo<string | null>(() => {
    if (override) {
      return override === COUNTRY_OVERRIDE_OTHER ? null : override;
    }
    if (countryProp) return countryProp.trim().toUpperCase();
    if (geo?.country) return geo.country;
    return countryFromNavigatorLanguage();
  }, [override, countryProp, geo]);

  const flags = useMemo(
    () => geo?.providers ?? readClientProviderFlags(),
    [geo],
  );

  const ordered = useMemo(
    () => orderedEnabledProviders(effectiveCountry, flags),
    [effectiveCountry, flags],
  );

  const active = ordered.filter((provider) => !(provider in failed));
  const unavailable = ordered.filter((provider) => provider in failed);

  const markFailed = (provider: RampProviderId, error: unknown) => {
    setFailed((prev) => ({ ...prev, [provider]: errorMessage(error) }));
    onProviderError?.(
      provider,
      error instanceof Error ? error : new Error(errorMessage(error)),
    );
  };

  const handleRegionChange = (value: string) => {
    const next = value === 'auto' ? null : value;
    setStoredCountryOverride(next);
    setOverride(next);
    setFailed({});
  };

  const handleLaunched = (provider: RampProviderId) => {
    onLaunched?.(provider);
  };

  const regionValue = override ?? 'auto';
  const detecting = !overrideLoaded || (!countryProp && !override && !geoChecked);

  const regionSelect = (
    <label className="flex items-center gap-2 text-xs text-gray-500">
      <span className="font-medium">Region</span>
      <select
        value={regionValue}
        onChange={(event) => handleRegionChange(event.target.value)}
        className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700"
        data-testid="ramp-picker-region"
      >
        {REGION_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );

  if (detecting) {
    return (
      <div className={className} data-testid="ramp-picker">
        <p className="text-sm text-gray-500">Detecting your region…</p>
      </div>
    );
  }

  if (ordered.length === 0) {
    return (
      <div className={className} data-testid="ramp-picker">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-sm text-gray-600">
            No fiat on-ramp is currently available for your region. Please fund
            this wallet from another exchange.
          </p>
          {regionSelect}
        </div>
      </div>
    );
  }

  const renderProvider = (provider: RampProviderId, isPrimary: boolean) => {
    const fiat = fiatCurrencyForProvider(provider, effectiveCountry);
    const amountForProvider = fiat === 'USD' ? amountUsd : undefined;

    const launcher = (() => {
      if (provider === 'coinbase') {
        const {
          onSuccess: coinbaseOnSuccess,
          onError: coinbaseOnError,
          ...coinbaseRest
        } = coinbase ?? {};
        return (
          <CoinbaseOnrampLauncher
            walletAddress={walletAddress}
            preferredAssetIntent={preferredAssetIntent}
            amount={amountForProvider}
            fiatCurrency={fiat}
            country={effectiveCountry ?? undefined}
            subdivision={subdivision}
            buttonLabel="Buy with Coinbase"
            {...coinbaseRest}
            onSuccess={(payload) => {
              coinbaseOnSuccess?.(payload);
              handleLaunched('coinbase');
            }}
            onError={(error) => {
              coinbaseOnError?.(error);
              const code = errorCode(error);
              if (!code || !NON_OUTAGE_COINBASE_CODES.has(code)) {
                markFailed('coinbase', error);
              }
            }}
          />
        );
      }
      if (provider === 'moonpay') {
        return (
          <MoonPayLauncher
            walletAddress={walletAddress}
            preferredAssetIntent={preferredAssetIntent === 'SUI' ? 'SUI' : 'USDC_ON_SUI'}
            amount={amountForProvider}
            fiatCurrency={fiat.toLowerCase() as MoonPayBaseCurrency}
            email={email}
            externalCustomerId={externalCustomerId}
            buttonLabel={`Buy with MoonPay${fiat === 'XAF' ? ' (XAF)' : ''}`}
            onSuccess={() => handleLaunched('moonpay')}
            onError={(error) => markFailed('moonpay', error)}
          />
        );
      }
      return (
        <TransakLauncher
          walletAddress={walletAddress}
          preferredAssetIntent={preferredAssetIntent === 'SUI' ? 'SUI' : 'USDC_ON_SUI'}
          fiatAmount={amountForProvider}
          fiatCurrency={fiat}
          countryCode={effectiveCountry ?? undefined}
          email={email}
          partnerOrderId={externalCustomerId}
          buttonLabel={`Buy with Transak${fiat === 'XAF' ? ' (XAF)' : ''}`}
          onSuccess={() => handleLaunched('transak')}
          onError={(error) => markFailed('transak', error)}
        />
      );
    })();

    return (
      <div
        key={provider}
        className="rounded-xl border border-gray-200 bg-white p-3"
        data-testid={`ramp-provider-${provider}`}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-gray-900">
            {RAMP_PROVIDER_LABELS[provider]}
          </p>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
              isPrimary
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-gray-100 text-gray-600'
            }`}
          >
            {isPrimary ? 'Recommended for your region' : 'Alternative'}
          </span>
        </div>
        {launcher}
      </div>
    );
  };

  return (
    <div className={className} data-testid="ramp-picker">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-600">
          Choose a regulated partner to convert local currency into the asset
          for your circle. Njangi is a non-custodial coordinator and does not
          settle fiat directly.
        </p>
        {regionSelect}
      </div>

      <div className="space-y-3">
        {active.map((provider, index) => renderProvider(provider, index === 0))}

        {active.length === 0 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
            <p className="text-sm text-amber-800">
              All providers are temporarily unavailable. Please try again in a
              moment.
            </p>
            <button
              type="button"
              onClick={() => setFailed({})}
              className="mt-2 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
            >
              Try all providers again
            </button>
          </div>
        )}

        {unavailable.length > 0 && active.length > 0 && (
          <div
            className="rounded-xl border border-gray-200 bg-gray-50 p-3"
            data-testid="ramp-picker-unavailable"
          >
            {unavailable.map((provider) => (
              <p key={provider} className="text-xs text-gray-500">
                {RAMP_PROVIDER_LABELS[provider]} is unavailable right now — try{' '}
                {RAMP_PROVIDER_LABELS[active[0]]} above.{' '}
                <button
                  type="button"
                  onClick={() =>
                    setFailed((prev) => {
                      const next = { ...prev };
                      delete next[provider];
                      return next;
                    })
                  }
                  className="font-medium text-gray-700 underline hover:text-gray-900"
                >
                  Retry {RAMP_PROVIDER_LABELS[provider]}
                </button>
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default RampPicker;
