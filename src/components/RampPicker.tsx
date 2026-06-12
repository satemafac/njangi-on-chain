import React, { useMemo } from 'react';
import CoinbaseOnrampLauncher, { type CoinbaseOnrampLauncherProps } from './CoinbaseOnrampLauncher';
import { MoonPayLauncher } from './MoonPayLauncher';
import { TransakLauncher } from './TransakLauncher';
import type { CoinbaseAssetIntent } from '@/types/coinbase-onramp';

export interface RampPickerProps {
  walletAddress: string;
  preferredAssetIntent: CoinbaseAssetIntent;
  amount?: number;
  fiatCurrency?: string;
  country?: string;
  subdivision?: string;
  email?: string;
  externalCustomerId?: string;
  className?: string;
  coinbase?: Partial<CoinbaseOnrampLauncherProps>;
}

interface ProviderConfig {
  coinbase: boolean;
  moonpay: boolean;
  transak: boolean;
}

function readProviderConfig(): ProviderConfig {
  return {
    coinbase: (process.env.NEXT_PUBLIC_COINBASE_ONRAMP_ENABLED || 'true').toLowerCase() === 'true',
    moonpay: (process.env.NEXT_PUBLIC_MOONPAY_ENABLED || 'false').toLowerCase() === 'true',
    transak: (process.env.NEXT_PUBLIC_TRANSAK_ENABLED || 'false').toLowerCase() === 'true',
  };
}

const AFRICA_COUNTRIES = new Set([
  'CM', 'NG', 'GH', 'KE', 'ZA', 'CI', 'SN', 'GA', 'CG', 'TG', 'BJ', 'BF', 'ML', 'NE', 'TD',
]);

/**
 * Surfaces the available regulated on/off-ramp providers in the order most
 * appropriate for the user's geography. Providers are still independently
 * KYC-gated and licensed by their operator; Njangi is a non-custodial
 * coordinator and never settles fiat directly.
 */
export const RampPicker: React.FC<RampPickerProps> = ({
  walletAddress,
  preferredAssetIntent,
  amount,
  fiatCurrency,
  country,
  subdivision,
  email,
  externalCustomerId,
  className,
  coinbase,
}) => {
  const providers = useMemo(readProviderConfig, []);

  const ordered = useMemo(() => {
    const list: Array<'coinbase' | 'moonpay' | 'transak'> = [];
    const isAfrica = country ? AFRICA_COUNTRIES.has(country.toUpperCase()) : false;
    if (isAfrica && providers.transak) list.push('transak');
    if (isAfrica && providers.moonpay) list.push('moonpay');
    if (providers.coinbase) list.push('coinbase');
    if (!isAfrica && providers.moonpay) list.push('moonpay');
    if (!isAfrica && providers.transak) list.push('transak');
    return list;
  }, [providers, country]);

  if (ordered.length === 0) {
    return (
      <p className={className}>
        No fiat on-ramp is currently available for your region. Please fund this wallet from
        another exchange.
      </p>
    );
  }

  return (
    <div className={className} data-testid="ramp-picker">
      <p className="mb-2 text-sm text-gray-600">
        Choose a regulated partner to convert local currency into the asset for your circle.
        Njangi is a non-custodial coordinator and does not settle fiat directly.
      </p>
      <div className="space-y-3">
        {ordered.map((provider) => {
          if (provider === 'coinbase') {
            return (
              <CoinbaseOnrampLauncher
                key="coinbase"
                walletAddress={walletAddress}
                preferredAssetIntent={preferredAssetIntent}
                amount={amount}
                fiatCurrency={fiatCurrency}
                country={country}
                subdivision={subdivision}
                {...(coinbase ?? {})}
              />
            );
          }
          if (provider === 'moonpay') {
            return (
              <MoonPayLauncher
                key="moonpay"
                walletAddress={walletAddress}
                preferredAssetIntent={preferredAssetIntent === 'SUI' ? 'SUI' : 'USDC_ON_SUI'}
                amount={amount}
                email={email}
                externalCustomerId={externalCustomerId}
              />
            );
          }
          return (
            <TransakLauncher
              key="transak"
              walletAddress={walletAddress}
              preferredAssetIntent={preferredAssetIntent === 'SUI' ? 'SUI' : 'USDC_ON_SUI'}
              fiatAmount={amount}
              fiatCurrency={fiatCurrency}
              countryCode={country}
              email={email}
              partnerOrderId={externalCustomerId}
            />
          );
        })}
      </div>
    </div>
  );
};

export default RampPicker;
