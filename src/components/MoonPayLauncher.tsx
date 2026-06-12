import React, { useCallback, useState } from 'react';
import type { MoonPayAssetIntent, MoonPayBaseCurrency } from '@/services/moonpay-service';

export interface MoonPayLauncherProps {
  walletAddress: string;
  preferredAssetIntent: MoonPayAssetIntent;
  amount?: number;
  fiatCurrency?: MoonPayBaseCurrency;
  email?: string;
  externalCustomerId?: string;
  buttonLabel?: string;
  className?: string;
  disabled?: boolean;
  onSuccess?: (url: string) => void;
  onError?: (error: Error) => void;
}

interface MoonPaySessionResponse {
  provider: 'moonpay';
  url: string;
  assetIntent: MoonPayAssetIntent;
}

export const MoonPayLauncher: React.FC<MoonPayLauncherProps> = ({
  walletAddress,
  preferredAssetIntent,
  amount,
  fiatCurrency,
  email,
  externalCustomerId,
  buttonLabel,
  className,
  disabled,
  onSuccess,
  onError,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const response = await fetch('/api/onramp/moonpay/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress,
          preferredAssetIntent,
          baseCurrency: fiatCurrency,
          baseCurrencyAmount: amount,
          email,
          externalCustomerId,
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`MoonPay session failed (${response.status}): ${body}`);
      }
      const session = (await response.json()) as MoonPaySessionResponse;
      window.open(session.url, '_blank', 'noopener,noreferrer');
      onSuccess?.(session.url);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e.message);
      onError?.(e);
    } finally {
      setLoading(false);
    }
  }, [walletAddress, preferredAssetIntent, amount, fiatCurrency, email, externalCustomerId, onSuccess, onError]);

  return (
    <div className={className}>
      <button
        type="button"
        disabled={disabled || loading || !walletAddress}
        onClick={launch}
        className="w-full rounded-md bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
      >
        {loading ? 'Opening MoonPay…' : buttonLabel ?? 'Buy with MoonPay'}
      </button>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
};

export default MoonPayLauncher;
