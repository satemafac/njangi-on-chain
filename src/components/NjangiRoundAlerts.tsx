import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Coins, Hourglass } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import {
  findCurrentCycleEscrow,
  readCycleEscrowState,
  listContributors,
} from '@/lib/cycle-escrow-discovery';
import { getNetworkConfig } from '@/services/network-config';
import { getPooledSuiClient } from '@/services/sui-rpc-failover';
import type { NetworkType } from '@/services/whatsapp-registry-service';

export interface CircleForAlerts {
  id: string;
  name: string;
  admin: string;
  coinSymbol?: string;
  coinDecimals?: number;
}

interface NjangiRoundAlertsProps {
  circles: CircleForAlerts[];
  userAddress: string | null;
  network: NetworkType;
}

type AlertKind = 'share-due' | 'your-turn' | 'admin-open-round';

interface ActionableAlert {
  kind: AlertKind;
  circleId: string;
  circleName: string;
  cycleNo: number;
  amount: string;
}

function formatAmount(baseUnits: string, decimals: number, symbol: string) {
  try {
    const v = BigInt(baseUnits);
    if (v === 0n) return `0 ${symbol}`;
    const divisor = 10n ** BigInt(decimals);
    const whole = v / divisor;
    const frac = v % divisor;
    if (frac === 0n) return `${whole.toString()} ${symbol}`;
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${whole.toString()}.${fracStr} ${symbol}`;
  } catch {
    return `${baseUnits} ${symbol}`;
  }
}

/**
 * Dashboard card that scans every circle the user belongs to and surfaces
 * njangi-friendly action prompts ("You have a share to pay", "It's your
 * turn to collect"). Entirely read-only — clicking a card deep links to
 * the circle's contribute page where the CycleEscrowPanel handles the
 * actual signing flow.
 */
export function NjangiRoundAlerts({ circles, userAddress, network }: NjangiRoundAlertsProps) {
  const { t } = useTranslation();
  const [alerts, setAlerts] = useState<ActionableAlert[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userAddress || circles.length === 0) {
      setAlerts([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const client = getPooledSuiClient({
        network,
        rpcUrl: getNetworkConfig(network).rpcUrl,
      });
      const collected: ActionableAlert[] = [];
      for (const circle of circles) {
        try {
          const escrow = await findCurrentCycleEscrow(client, network, circle.id);
          if (!escrow) continue;
          const state = await readCycleEscrowState(escrow.escrowId, network, client);
          if (!state || state.claimed) continue;

          const symbol = circle.coinSymbol ?? 'SUI';
          const decimals = circle.coinDecimals ?? 9;
          const friendly = formatAmount(state.contributionAmount, decimals, symbol);
          const isRecipient =
            state.recipient.toLowerCase() === userAddress.toLowerCase();
          const fullyFunded =
            state.contributorsSoFar >= state.requiredContributors &&
            state.requiredContributors > 0;

          if (fullyFunded && isRecipient) {
            collected.push({
              kind: 'your-turn',
              circleId: circle.id,
              circleName: circle.name,
              cycleNo: state.cycleNo,
              amount: formatAmount(state.totalContributed, decimals, symbol),
            });
            continue;
          }

          if (fullyFunded && circle.admin.toLowerCase() === userAddress.toLowerCase()) {
            // Admin can open the next round once the current one wraps up.
            collected.push({
              kind: 'admin-open-round',
              circleId: circle.id,
              circleName: circle.name,
              cycleNo: state.cycleNo + 1,
              amount: friendly,
            });
            continue;
          }

          // Has the user already paid for this round?
          const contributors = await listContributors(escrow.escrowId, network, client);
          const alreadyPaid = contributors.some(
            (c) => c.toLowerCase() === userAddress.toLowerCase(),
          );
          if (!alreadyPaid && !isRecipient) {
            collected.push({
              kind: 'share-due',
              circleId: circle.id,
              circleName: circle.name,
              cycleNo: state.cycleNo,
              amount: friendly,
            });
          }
        } catch (err) {
          console.warn('[NjangiRoundAlerts] circle scan failed', circle.id, err);
        }
      }
      if (!cancelled) {
        setAlerts(collected);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [circles, userAddress, network]);

  const grouped = useMemo(() => {
    return {
      yourTurn: alerts.filter((a) => a.kind === 'your-turn'),
      shareDue: alerts.filter((a) => a.kind === 'share-due'),
      adminOpen: alerts.filter((a) => a.kind === 'admin-open-round'),
    };
  }, [alerts]);

  if (!userAddress || circles.length === 0) return null;
  if (!loading && alerts.length === 0) return null;

  return (
    <section className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4 sm:p-5">
      <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-800">
        {t('escrow.sectionTitle')}
      </h2>
      <div className="mt-3 grid gap-3">
        {grouped.yourTurn.map((a) => (
          <Link
            key={`turn-${a.circleId}`}
            href={`/circle/${a.circleId}/contribute`}
            className="flex items-center justify-between gap-3 rounded-xl border border-emerald-300 bg-white p-3 shadow-sm transition hover:border-emerald-400"
          >
            <div className="flex items-start gap-3">
              <Coins className="mt-0.5 h-5 w-5 text-emerald-700" />
              <div>
                <p className="text-sm font-semibold text-emerald-900">
                  {t('alerts.yourTurn.title')}
                </p>
                <p className="mt-1 text-sm text-slate-700">
                  {t('alerts.yourTurn.body', { circle: a.circleName, amount: a.amount })}
                </p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-emerald-700" />
          </Link>
        ))}

        {grouped.shareDue.map((a) => (
          <Link
            key={`due-${a.circleId}`}
            href={`/circle/${a.circleId}/contribute`}
            className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-white p-3 shadow-sm transition hover:border-amber-300"
          >
            <div className="flex items-start gap-3">
              <Hourglass className="mt-0.5 h-5 w-5 text-amber-600" />
              <div>
                <p className="text-sm font-semibold text-amber-900">
                  {t('alerts.yourShareDue.title')}
                </p>
                <p className="mt-1 text-sm text-slate-700">
                  {t('alerts.yourShareDue.body', { circle: a.circleName, amount: a.amount })}
                </p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-amber-700" />
          </Link>
        ))}

        {grouped.adminOpen.map((a) => (
          <Link
            key={`admin-${a.circleId}`}
            href={`/circle/${a.circleId}/contribute`}
            className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm transition hover:border-slate-300"
          >
            <div className="flex items-start gap-3">
              <Coins className="mt-0.5 h-5 w-5 text-slate-700" />
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  {t('alerts.adminOpenRound.title')}
                </p>
                <p className="mt-1 text-sm text-slate-700">
                  {t('alerts.adminOpenRound.body', { circle: a.circleName, cycle: a.cycleNo })}
                </p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-slate-700" />
          </Link>
        ))}
      </div>
    </section>
  );
}

export default NjangiRoundAlerts;
