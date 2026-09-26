import { LocaleSwitcher } from '../ui/LocaleSwitcher';
import SiteHeader from './SiteHeader';
import { focusRing } from './ui';

type Network = 'testnet' | 'mainnet';

type Props = {
  signedIn: boolean;
  network: Network;
  onSwitchNetwork: (network: Network) => void;
  onLogin: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

/**
 * The landing's header: the shared Apple bar (SiteHeader) plus the two
 * controls only the home page carries — language and the Testnet/Mainnet
 * switch — inline on desktop and as rows in the mobile sheet.
 */
export default function LandingHeader({ signedIn, network, onSwitchNetwork, onLogin, t }: Props) {
  const networkName = network === 'testnet' ? t('nav.testnet') : t('nav.mainnet');

  const networkControl = (size: 'sm' | 'lg', beforeSwitch?: () => void) => (
    <div
      role="group"
      aria-label={t('nav.viewing', { network: networkName })}
      className={`inline-flex items-center rounded-full bg-white/[0.08] p-[3px] ${
        size === 'lg' ? 'h-11 w-full' : 'h-8'
      }`}
    >
      {(['testnet', 'mainnet'] as const).map((value) => {
        const selected = network === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={selected}
            onClick={() => {
              if (!selected) {
                beforeSwitch?.();
                onSwitchNetwork(value);
              }
            }}
            className={`inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-full px-3 font-medium transition-colors duration-200 ${
              size === 'lg' ? 'text-[15px]' : 'text-[12px]'
            } ${selected ? 'bg-white/[0.16] text-mist' : 'text-mist-3 hover:text-mist'} ${focusRing}`}
          >
            {selected && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-gold" />}
            {value === 'testnet' ? t('nav.testnet') : t('nav.mainnet')}
          </button>
        );
      })}
    </div>
  );

  return (
    <SiteHeader
      links={[
        { href: '/learn', label: t('nav.learn') },
        { href: '/faq', label: t('nav.faq') },
        { href: '#launch', label: t('nav.mainnetUpdates') },
      ]}
      primary={
        signedIn
          ? { label: t('nav.openDashboard'), href: '/dashboard' }
          : { label: t('nav.login'), onClick: onLogin }
      }
      controls={
        <>
          <LocaleSwitcher compact variant="glass" />
          {networkControl('sm')}
        </>
      }
      sheetExtras={(close) => (
        <>
          <div className="flex items-center justify-between gap-4">
            <span className="text-[13px] text-mist-3">Language</span>
            <LocaleSwitcher compact variant="glass" />
          </div>
          <div className="space-y-3">
            <span className="block text-[13px] text-mist-3">
              {t('nav.viewing', { network: networkName })}
            </span>
            {networkControl('lg', close)}
          </div>
        </>
      )}
    />
  );
}
