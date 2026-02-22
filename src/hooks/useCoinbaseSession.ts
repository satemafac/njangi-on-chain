import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CoinbaseApiErrorPayload,
  CoinbaseAssetIntent,
  CoinbaseSessionTokenPayload,
} from '@/types/coinbase-onramp';

export interface UseCoinbaseSessionParams {
  walletAddress: string;
  preferredAssetIntent: CoinbaseAssetIntent;
  fiatAmount?: number;
  fiatCurrency?: string;
  country?: string;
  subdivision?: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface CoinbaseSessionClientError {
  code: string;
  message: string;
  status?: number;
  fallbackProvider?: 'moonpay' | null;
  isRetryable: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toClientError(
  error: unknown,
  status?: number,
): CoinbaseSessionClientError {
  if (error && typeof error === 'object') {
    const maybePayload = error as Partial<CoinbaseApiErrorPayload> & {
      message?: string;
      code?: string;
    };
    const errorCode = maybePayload.error ?? maybePayload.code;

    if (typeof errorCode === 'string') {
      return {
        code: errorCode,
        message:
          typeof maybePayload.message === 'string'
            ? maybePayload.message
            : 'Unable to initialize Coinbase checkout.',
        status,
        fallbackProvider:
          maybePayload.fallbackProvider === undefined
            ? 'moonpay'
            : maybePayload.fallbackProvider,
        isRetryable:
          errorCode === 'COINBASE_TIMEOUT' ||
          errorCode === 'COINBASE_NETWORK_ERROR' ||
          errorCode === 'COINBASE_RATE_LIMITED' ||
          status === 429 ||
          status === 503 ||
          status === 504,
      };
    }
  }

  return {
    code: 'NETWORK_ERROR',
    message: 'Unable to initialize Coinbase checkout.',
    status,
    fallbackProvider: 'moonpay',
    isRetryable: status === 429 || status === 503 || status === 504 || !status,
  };
}

interface SessionRequestOverrides {
  walletAddress?: string;
  preferredAssetIntent?: CoinbaseAssetIntent;
  fiatAmount?: number;
  fiatCurrency?: string;
  country?: string;
  subdivision?: string;
}

export function useCoinbaseSession(params: UseCoinbaseSessionParams) {
  const [data, setData] = useState<CoinbaseSessionTokenPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<CoinbaseSessionClientError | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  const maxRetries = params.maxRetries ?? 2;
  const retryDelayMs = params.retryDelayMs ?? 400;

  const cancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setLoading(false);
  }, []);

  const reset = useCallback(() => {
    setData(null);
    setError(null);
  }, []);

  const refetch = useCallback(
    async (
      overrides?: SessionRequestOverrides,
    ): Promise<CoinbaseSessionTokenPayload | null> => {
      cancel();
      setError(null);

      const walletAddress =
        overrides?.walletAddress ?? params.walletAddress?.trim();
      const preferredAssetIntent =
        overrides?.preferredAssetIntent ?? params.preferredAssetIntent;

      if (!walletAddress || !preferredAssetIntent) {
        const nextError: CoinbaseSessionClientError = {
          code: 'VALIDATION_ERROR',
          message: 'Wallet address and asset intent are required.',
          status: 400,
          fallbackProvider: 'moonpay',
          isRetryable: false,
        };
        setError(nextError);
        return null;
      }

      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      setLoading(true);

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const controller = new AbortController();
        abortRef.current = controller;

        try {
          const response = await fetch('/api/onramp/coinbase/session', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              walletAddress,
              preferredAssetIntent,
              fiatAmount: overrides?.fiatAmount ?? params.fiatAmount,
              fiatCurrency: overrides?.fiatCurrency ?? params.fiatCurrency,
              country: overrides?.country ?? params.country,
              subdivision: overrides?.subdivision ?? params.subdivision,
            }),
            signal: controller.signal,
          });

          const responseText = await response.text();
          const parsedPayload = responseText
            ? (JSON.parse(responseText) as
                | CoinbaseSessionTokenPayload
                | CoinbaseApiErrorPayload)
            : null;

          if (!response.ok) {
            const clientError = toClientError(parsedPayload, response.status);
            if (
              clientError.isRetryable &&
              attempt < maxRetries &&
              !controller.signal.aborted
            ) {
              await delay(retryDelayMs * Math.pow(2, attempt));
              continue;
            }

            if (requestId === requestIdRef.current) {
              setError(clientError);
              setLoading(false);
            }
            return null;
          }

          if (requestId === requestIdRef.current) {
            const nextData = parsedPayload as CoinbaseSessionTokenPayload;
            setData(nextData);
            setLoading(false);
            return nextData;
          }

          return null;
        } catch (fetchError) {
          if (
            fetchError &&
            typeof fetchError === 'object' &&
            'name' in fetchError &&
            fetchError.name === 'AbortError'
          ) {
            if (requestId === requestIdRef.current) {
              setLoading(false);
            }
            return null;
          }

          const clientError = toClientError(fetchError);
          if (attempt < maxRetries) {
            await delay(retryDelayMs * Math.pow(2, attempt));
            continue;
          }

          if (requestId === requestIdRef.current) {
            setError(clientError);
            setLoading(false);
          }
          return null;
        } finally {
          if (abortRef.current === controller) {
            abortRef.current = null;
          }
        }
      }

      if (requestId === requestIdRef.current) {
        setLoading(false);
      }
      return null;
    },
    [
      cancel,
      maxRetries,
      params.country,
      params.fiatAmount,
      params.fiatCurrency,
      params.preferredAssetIntent,
      params.subdivision,
      params.walletAddress,
      retryDelayMs,
    ],
  );

  useEffect(() => () => cancel(), [cancel]);

  return {
    data,
    loading,
    error,
    refetch,
    cancel,
    reset,
  };
}
