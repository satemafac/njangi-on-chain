// circle-coin-terms.ts — a circle's pinned coin and amounts (package v11),
// as the manage and contribute pages show them.
//
// From v11 every circle pins its coin, decimals and amounts on chain
// (CircleAssetPolicy). Those are the amounts members actually pay, so the
// pages show them in that coin ("0.1 USDC") instead of converting a USD
// figure to SUI at today's price, which for a USDC circle quoted a coin its
// members never pay (and "0.000 SUI" once v11 stored no SUI amounts for it).
// A pinned circle's coin cannot be switched, so the SUI/USDC switch is not
// offered for it.

import { useCallback, useEffect, useState } from 'react';
import type { NetworkType } from '@/config/public-env';
import { formatCoinAmount, resolveSupportedCoin } from '@/lib/supported-coins';
import { readCircleAssetPolicy, type V11CircleAssetPolicy } from '@/lib/v11-circle-tx';

export type CircleCoinTerms =
  | { status: 'loading' }
  /** Pinned terms. `symbol` and the labels are null for a coin the app does not support. */
  | {
      status: 'pinned';
      coinType: string;
      symbol: string | null;
      contributionLabel: string | null;
      depositLabel: string | null;
    }
  /** No pinned terms: a circle that predates v11 and was never converted. */
  | { status: 'unpinned' }
  /** The policy could not be read. Never treated as "unpinned". */
  | { status: 'unknown' };

export function describeCircleCoinTerms(
  policy: V11CircleAssetPolicy | null,
  network: NetworkType,
): CircleCoinTerms {
  if (!policy) return { status: 'unpinned' };
  const terms = policy.settlement;
  const coin = resolveSupportedCoin(terms.coinType, network);
  return {
    status: 'pinned',
    coinType: terms.coinType,
    symbol: coin?.symbol ?? null,
    contributionLabel: coin ? formatCoinAmount(terms.contributionAmount, coin) : null,
    depositLabel: coin ? formatCoinAmount(terms.securityDeposit, coin) : null,
  };
}

type PolicyClient = Parameters<typeof readCircleAssetPolicy>[0];

/**
 * Reads the circle's pinned terms once per circle. `reload` reads again; a
 * failed read is `unknown`, never `unpinned`.
 */
export function useCircleCoinTerms(
  circleId: string | null | undefined,
  network: NetworkType,
  getClient: () => PolicyClient,
): { terms: CircleCoinTerms; reload: () => void } {
  const [terms, setTerms] = useState<CircleCoinTerms>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!circleId) return undefined;
    let cancelled = false;
    setTerms({ status: 'loading' });
    readCircleAssetPolicy(getClient(), circleId)
      .then((policy) => {
        if (!cancelled) setTerms(describeCircleCoinTerms(policy, network));
      })
      .catch((error) => {
        console.warn('[circle-coin-terms] could not read the circle asset policy', { circleId, error });
        if (!cancelled) setTerms({ status: 'unknown' });
      });
    return () => {
      cancelled = true;
    };
    // getClient is a factory; reading again is driven by circleId, network and reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circleId, network, attempt]);

  return { terms, reload };
}
