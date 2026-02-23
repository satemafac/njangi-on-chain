import React, { useMemo, useState } from 'react';
import { buildCoinbaseOnrampUrl } from '@/lib/coinbase-onramp';
import { useCoinbaseSession, type CoinbaseSessionClientError } from '@/hooks/useCoinbaseSession';
import type {
  CoinbaseApiErrorPayload,
  CoinbaseAssetIntent,
  CoinbaseOptionsPayload,
  CoinbaseSessionTokenPayload,
} from '@/types/coinbase-onramp';

export interface CoinbaseOnrampLauncherSuccess {
  session: CoinbaseSessionTokenPayload;
  url: string;
}

export interface CoinbaseOnrampLauncherProps {
  walletAddress: string;
  preferredAssetIntent: CoinbaseAssetIntent;
  amount?: number;
  fiatCurrency?: string;
  country?: string;
  subdivision?: string;
  providerFlag?: 'auto' | 'coinbase' | 'moonpay';
  disabled?: boolean;
  className?: string;
  buttonLabel?: string;
  onSuccess?: (payload: CoinbaseOnrampLauncherSuccess) => void;
  onError?: (
    error: CoinbaseSessionClientError | CoinbaseApiErrorPayload | Error,
  ) => void;
  onCancel?: () => void;
}

function isRetryableCode(code: string, status?: number): boolean {
  return (
    code === 'COINBASE_TIMEOUT' ||
    code === 'COINBASE_NETWORK_ERROR' ||
    code === 'COINBASE_RATE_LIMITED' ||
    code === 'RATE_LIMITED' ||
    status === 429 ||
    status === 503 ||
    status === 504
  );
}

function toClientError(
  payload: CoinbaseApiErrorPayload,
  status?: number,
): CoinbaseSessionClientError {
  return {
    code: payload.error,
    message: payload.message,
    status,
    fallbackProvider: payload.fallbackProvider,
    isRetryable: isRetryableCode(payload.error, status),
  };
}

function toFallbackApiError(
  code: string,
  message: string,
  fallbackProvider: 'moonpay' | null = 'moonpay',
): CoinbaseApiErrorPayload {
  return {
    provider: 'coinbase',
    error: code,
    message,
    fallbackProvider,
  };
}

function readApiErrorPayload(payload: unknown): CoinbaseApiErrorPayload | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const maybePayload = payload as Partial<CoinbaseApiErrorPayload>;
  if (
    maybePayload.provider === 'coinbase' &&
    typeof maybePayload.error === 'string' &&
    typeof maybePayload.message === 'string' &&
    (maybePayload.fallbackProvider === 'moonpay' ||
      maybePayload.fallbackProvider === null)
  ) {
    return {
      provider: 'coinbase',
      error: maybePayload.error,
      message: maybePayload.message,
      fallbackProvider: maybePayload.fallbackProvider,
    };
  }

  return null;
}

function readOptionsPayload(payload: unknown): CoinbaseOptionsPayload | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const maybePayload = payload as Partial<CoinbaseOptionsPayload>;
  if (
    maybePayload.provider === 'coinbase' &&
    typeof maybePayload.eligible === 'boolean' &&
    Array.isArray(maybePayload.supportedIntents)
  ) {
    return maybePayload as CoinbaseOptionsPayload;
  }

  return null;
}

async function fetchOptionsPayload(input: {
  walletAddress: string;
  country?: string;
  subdivision?: string;
}): Promise<{
  status: number;
  options: CoinbaseOptionsPayload | null;
  error: CoinbaseApiErrorPayload | null;
}> {
  const params = new URLSearchParams();
  params.set('walletAddress', input.walletAddress);
  if (input.country) {
    params.set('country', input.country);
  }
  if (input.subdivision) {
    params.set('subdivision', input.subdivision);
  }

  let response: Response;
  try {
    response = await fetch(`/api/onramp/coinbase/options?${params.toString()}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
  } catch {
    return {
      status: 0,
      options: null,
      error: toFallbackApiError(
        'COINBASE_NETWORK_ERROR',
        'Unable to reach Coinbase eligibility service.',
      ),
    };
  }

  const responseText = await response.text();
  let parsedPayload: unknown = null;
  if (responseText) {
    try {
      parsedPayload = JSON.parse(responseText) as unknown;
    } catch {
      parsedPayload = null;
    }
  }

  if (!response.ok) {
    return {
      status: response.status,
      options: null,
      error:
        readApiErrorPayload(parsedPayload) ??
        toFallbackApiError(
          'COINBASE_OPTIONS_ERROR',
          'Unable to load Coinbase eligibility options.',
        ),
    };
  }

  return {
    status: response.status,
    options: readOptionsPayload(parsedPayload),
    error: null,
  };
}

function mapErrorMessage(
  error: CoinbaseSessionClientError | CoinbaseApiErrorPayload | Error | null,
): string {
  if (!error) {
    return '';
  }

  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  const message =
    'message' in error && typeof error.message === 'string'
      ? error.message
      : 'Payment setup temporarily unavailable. Please retry.';

  if (code === 'UNSUPPORTED_REGION') {
    return 'Coinbase checkout is currently available for US users only.';
  }

  if (code === 'UNSUPPORTED_SUBDIVISION') {
    return 'Coinbase checkout is unavailable in your selected US region.';
  }

  if (
    code === 'UNSUPPORTED_ASSET' ||
    code === 'UNSUPPORTED_ASSET_OR_NETWORK' ||
    code === 'UNSUPPORTED_INTENT' ||
    code === 'COINBASE_INELIGIBLE'
  ) {
    return 'Coinbase does not currently support this asset for your location.';
  }

  if (code === 'RATE_LIMITED' || code === 'COINBASE_RATE_LIMITED') {
    return 'Too many payment setup attempts. Please wait and retry.';
  }

  if (code === 'POPUP_BLOCKED') {
    return 'Popup was blocked by your browser. Please allow popups and retry.';
  }

  return message || 'Payment setup temporarily unavailable. Retry?';
}

/**
 * Reusable Coinbase hosted onramp launcher.
 *
 * Usage:
 * `<CoinbaseOnrampLauncher walletAddress={addr} preferredAssetIntent="SUI" amount={100} />`
 * `<CoinbaseOnrampLauncher walletAddress={addr} preferredAssetIntent="USDC_ON_SUI" amount={100} />`
 */
export default function CoinbaseOnrampLauncher({
  walletAddress,
  preferredAssetIntent,
  amount = 50,
  fiatCurrency = 'USD',
  country = 'US',
  subdivision,
  providerFlag = 'coinbase',
  disabled = false,
  className,
  buttonLabel = 'Buy with Coinbase',
  onSuccess,
  onError,
  onCancel,
}: CoinbaseOnrampLauncherProps) {
  const [localError, setLocalError] = useState<CoinbaseSessionClientError | null>(
    null,
  );
  const [launchSucceeded, setLaunchSucceeded] = useState(false);

  const { data, loading, error, refetch, cancel, reset } = useCoinbaseSession({
    walletAddress,
    preferredAssetIntent,
    fiatAmount: amount,
    fiatCurrency,
    country,
    subdivision,
  });

  const effectiveError = localError ?? error;

  const isProviderEnabled = providerFlag === 'coinbase' || providerFlag === 'auto';
  const isButtonDisabled = disabled || !isProviderEnabled || loading;

  const statusText = useMemo(() => {
    if (loading) {
      return 'Opening Coinbase checkout...';
    }
    if (launchSucceeded) {
      return 'Coinbase checkout opened.';
    }
    return '';
  }, [loading, launchSucceeded]);

  const handleLaunch = async () => {
    setLocalError(null);
    setLaunchSucceeded(false);

    const normalizedWalletAddress = walletAddress.trim();
    if (!normalizedWalletAddress) {
      const validationError: CoinbaseSessionClientError = {
        code: 'VALIDATION_ERROR',
        message: 'Wallet address is required.',
        status: 400,
        fallbackProvider: 'moonpay',
        isRetryable: false,
      };
      setLocalError(validationError);
      onError?.(validationError);
      return;
    }

    const optionsResult = await fetchOptionsPayload({
      walletAddress: normalizedWalletAddress,
      country,
      subdivision,
    });
    if (optionsResult.error) {
      const clientError = toClientError(optionsResult.error, optionsResult.status);
      setLocalError(clientError);
      onError?.(optionsResult.error);
      return;
    }

    const options = optionsResult.options;
    if (!options) {
      const malformedOptionsError = toFallbackApiError(
        'COINBASE_OPTIONS_ERROR',
        'Coinbase eligibility response could not be parsed.',
      );
      const clientError = toClientError(malformedOptionsError, optionsResult.status);
      setLocalError(clientError);
      onError?.(malformedOptionsError);
      return;
    }

    const supportsIntent = options.supportedIntents.includes(preferredAssetIntent);
    if (!options.eligible || !supportsIntent) {
      const ineligibleError = toFallbackApiError(
        options.reasonCode ?? (!supportsIntent ? 'UNSUPPORTED_INTENT' : 'COINBASE_INELIGIBLE'),
        options.message ??
          (!supportsIntent
            ? 'Selected asset is unavailable via Coinbase for this user context.'
            : 'Coinbase is unavailable for this user context.'),
        options.fallbackProvider,
      );
      const clientError = toClientError(ineligibleError, 400);
      setLocalError(clientError);
      onError?.(ineligibleError);
      return;
    }

    const session = await refetch();
    if (!session) {
      const sessionError =
        error ??
        ({
          code: 'COINBASE_SESSION_ERROR',
          message: 'Unable to initialize Coinbase checkout.',
          status: 503,
          fallbackProvider: 'moonpay',
          isRetryable: true,
        } as CoinbaseSessionClientError);
      setLocalError(sessionError);
      onError?.(sessionError);
      return;
    }

    const url = buildCoinbaseOnrampUrl({
      sessionToken: session.token,
      preferredAssetIntent,
      fiatAmount: amount,
      fiatCurrency,
    });

    const openedWindow =
      typeof window !== 'undefined'
        ? window.open(url, '_blank', 'noopener,noreferrer')
        : null;

    if (!openedWindow) {
      const popupError: CoinbaseSessionClientError = {
        code: 'POPUP_BLOCKED',
        message: 'Popup blocked by browser.',
        status: 400,
        fallbackProvider: 'moonpay',
        isRetryable: true,
      };
      setLocalError(popupError);
      onError?.(popupError);
      return;
    }

    setLaunchSucceeded(true);
    onSuccess?.({ session, url });
  };

  const handleRetry = async () => {
    reset();
    setLocalError(null);
    await handleLaunch();
  };

  const handleCancel = () => {
    cancel();
    setLocalError(null);
    setLaunchSucceeded(false);
    onCancel?.();
  };

  return (
    <div className={`space-y-3 ${className ?? ''}`}>
      <div className="rounded-2xl border border-blue-100 bg-gradient-to-br from-blue-50 via-white to-cyan-50 p-3 shadow-sm">
        <button
          type="button"
          onClick={handleLaunch}
          disabled={isButtonDisabled}
          className="inline-flex w-full items-center justify-center rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:from-blue-500 hover:to-indigo-500 hover:shadow-md disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-400"
        >
          {loading ? 'Setting up...' : buttonLabel}
        </button>

        {statusText && (
          <p className="mt-2 text-xs font-medium text-blue-700" role="status">
            {statusText}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleCancel}
          className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
        >
          Cancel
        </button>

        {effectiveError && (
          <button
            type="button"
            onClick={handleRetry}
            disabled={loading}
            className="inline-flex min-h-[44px] flex-1 items-center justify-center rounded-xl border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700 transition-colors hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Retry
          </button>
        )}
      </div>

      {effectiveError && (
        <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {mapErrorMessage(effectiveError)}
        </p>
      )}

      {!isProviderEnabled && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          Coinbase is disabled by provider flag.
        </p>
      )}

      {data?.channelId && (
        <p className="text-xs text-slate-500">Session channel: {data.channelId}</p>
      )}
    </div>
  );
}
