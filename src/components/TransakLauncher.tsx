import React, { useCallback, useState } from 'react';
import type { TransakAssetIntent } from '@/services/transak-service';

export interface TransakLauncherProps {
  walletAddress: string;
  preferredAssetIntent: TransakAssetIntent;
  fiatAmount?: number;
  fiatCurrency?: string;
  countryCode?: string;
  email?: string;
  partnerOrderId?: string;
  buttonLabel?: string;
  className?: string;
  disabled?: boolean;
  onSuccess?: (url: string) => void;
  onError?: (error: Error) => void;
}

interface TransakSessionResponse {
  provider: 'transak';
  url: string;
  assetIntent: TransakAssetIntent;
}

export const TransakLauncher: React.FC<TransakLauncherProps> = ({
  walletAddress,
  preferredAssetIntent,
  fiatAmount,
  fiatCurrency,
  countryCode,
  email,
  partnerOrderId,
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
      const response = await fetch('/api/onramp/transak/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress,
          preferredAssetIntent,
          fiatAmount,
          fiatCurrency,
          countryCode,
          email,
          partnerOrderId,
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Transak session failed (${response.status}): ${body}`);
      }
      const session = (await response.json()) as TransakSessionResponse;
      window.open(session.url, '_blank', 'noopener,noreferrer');
      onSuccess?.(session.url);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e.message);
      onError?.(e);
    } finally {
      setLoading(false);
    }
  }, [walletAddress, preferredAssetIntent, fiatAmount, fiatCurrency, countryCode, email, partnerOrderId, onSuccess, onError]);

  return (
    <div className={className}>
      <button
        type="button"
        disabled={disabled || loading || !walletAddress}
        onClick={launch}
        className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {loading ? 'Opening Transak…' : buttonLabel ?? 'Buy with Transak'}
      </button>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </div>
  );
};

export default TransakLauncher;
