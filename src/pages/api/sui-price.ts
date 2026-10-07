import { NextApiRequest, NextApiResponse } from 'next';

// Every answer carries a price, so callers must read the provenance:
//   live        stale: false, fallback: false, fetchedAt: now
//   server-cache (< 5 min)  stale: false, fallback: false, fetchedAt
//   stale-cache  (< 6 h)    stale: true,  fallback: false, fetchedAt
//   fallback     stale: true,  fallback: true,  no fetchedAt — the hardcoded
//                FALLBACK_PRICE, which nobody quoted. Fine for a "≈ $" label,
//                never for the SUI amount a circle is pinned to
//                (src/lib/sui-price-reading.ts).
type PriceApiResponse = {
  success: boolean;
  data?: {
    price: number;
    source: string;
    /** Not a live quote this request: a cached one, or the fallback. */
    stale: boolean;
    /** The hardcoded FALLBACK_PRICE: no source quoted it. */
    fallback: boolean;
    /** When a live source last quoted the price (epoch ms). Absent for the fallback. */
    fetchedAt?: number;
  };
  message?: string;
};

type PriceSource = {
  name: string;
  url: string;
  parsePrice: (payload: unknown) => number | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

const PRICE_SOURCES: PriceSource[] = [
  {
    name: 'CoinGecko',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd',
    parsePrice: (payload) => {
      const sui = asRecord(asRecord(payload)?.sui);
      const price = sui?.usd;
      return typeof price === 'number' ? price : null;
    },
  },
  {
    name: 'Jupiter',
    url: 'https://price.jup.ag/v4/price?ids=SUI',
    parsePrice: (payload) => {
      const data = asRecord(asRecord(payload)?.data);
      const sui = asRecord(data?.SUI);
      const price = sui?.price;
      return typeof price === 'number' ? price : null;
    },
  },
  {
    name: 'Binance',
    url: 'https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT',
    parsePrice: (payload) => {
      const price = asRecord(payload)?.price;
      if (typeof price === 'string') {
        const parsed = Number.parseFloat(price);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    },
  },
];

const REQUEST_TIMEOUT_MS = 3000;
const SERVER_CACHE_TTL_MS = 5 * 60 * 1000;
const SERVER_STALE_TTL_MS = 6 * 60 * 60 * 1000;
const FALLBACK_PRICE = 3.71;

let lastSuccessfulPrice: { price: number; source: string; timestamp: number } | null = null;

async function fetchPriceFromSource(source: PriceSource): Promise<number | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(source.url, {
      headers: {
        'Accept': 'application/json',
      },
      signal: controller.signal,
    });

    const rawBody = await response.text();
    const trimmedBody = rawBody.trim();
    const contentType = response.headers.get('content-type') || 'unknown';

    if (!response.ok) {
      console.warn('[API][sui-price] upstream request failed:', {
        source: source.name,
        status: response.status,
        contentType,
      });
      return null;
    }

    if (!trimmedBody || trimmedBody.startsWith('<')) {
      console.warn('[API][sui-price] upstream returned non-JSON response:', {
        source: source.name,
        contentType,
        preview: trimmedBody.slice(0, 80),
      });
      return null;
    }

    const payload = JSON.parse(trimmedBody);
    const price = source.parsePrice(payload);

    if (price !== null && price > 0) {
      return price;
    }

    console.warn('[API][sui-price] upstream returned invalid price payload:', {
      source: source.name,
    });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[API][sui-price] ${source.name} request failed: ${message}`);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<PriceApiResponse>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Method not allowed',
    });
  }

  const now = Date.now();

  if (lastSuccessfulPrice && now - lastSuccessfulPrice.timestamp < SERVER_CACHE_TTL_MS) {
    return res.status(200).json({
      success: true,
      data: {
        price: lastSuccessfulPrice.price,
        source: `${lastSuccessfulPrice.source} (server-cache)`,
        stale: false,
        fallback: false,
        fetchedAt: lastSuccessfulPrice.timestamp,
      },
    });
  }

  for (const source of PRICE_SOURCES) {
    const price = await fetchPriceFromSource(source);

    if (price !== null) {
      lastSuccessfulPrice = {
        price,
        source: source.name,
        timestamp: now,
      };

      return res.status(200).json({
        success: true,
        data: {
          price,
          source: source.name,
          stale: false,
          fallback: false,
          fetchedAt: now,
        },
      });
    }
  }

  if (lastSuccessfulPrice && now - lastSuccessfulPrice.timestamp < SERVER_STALE_TTL_MS) {
    return res.status(200).json({
      success: true,
      data: {
        price: lastSuccessfulPrice.price,
        source: `${lastSuccessfulPrice.source} (stale-cache)`,
        stale: true,
        fallback: false,
        fetchedAt: lastSuccessfulPrice.timestamp,
      },
      message: 'Live SUI price sources failed; returning stale server cache.',
    });
  }

  // Still 200: the only caller (price-service.ts) treats a non-2xx as "no
  // answer" and substitutes its own copy of this number, which would lose
  // the flag that says so. The flag is the point.
  return res.status(200).json({
    success: true,
    data: {
      price: FALLBACK_PRICE,
      source: 'fallback',
      stale: true,
      fallback: true,
    },
    message: 'Live SUI price sources failed; returning fallback SUI price.',
  });
}
