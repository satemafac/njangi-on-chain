import { NextApiRequest, NextApiResponse } from 'next';

type PriceApiResponse = {
  success: boolean;
  data?: {
    price: number;
    source: string;
    stale?: boolean;
  };
  message?: string;
};

type PriceSource = {
  name: string;
  url: string;
  parsePrice: (payload: any) => number | null;
};

const PRICE_SOURCES: PriceSource[] = [
  {
    name: 'CoinGecko',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd',
    parsePrice: (payload) => {
      const price = payload?.sui?.usd;
      return typeof price === 'number' ? price : null;
    },
  },
  {
    name: 'Jupiter',
    url: 'https://price.jup.ag/v4/price?ids=SUI',
    parsePrice: (payload) => {
      const price = payload?.data?.SUI?.price;
      return typeof price === 'number' ? price : null;
    },
  },
  {
    name: 'Binance',
    url: 'https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT',
    parsePrice: (payload) => {
      const price = payload?.price;
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
        },
      });
    }
  }

  return res.status(200).json({
    success: true,
    data: {
      price:
        lastSuccessfulPrice && now - lastSuccessfulPrice.timestamp < SERVER_STALE_TTL_MS
          ? lastSuccessfulPrice.price
          : FALLBACK_PRICE,
      source:
        lastSuccessfulPrice && now - lastSuccessfulPrice.timestamp < SERVER_STALE_TTL_MS
          ? `${lastSuccessfulPrice.source} (stale-cache)`
          : 'server-fallback',
      stale: true,
    },
    message:
      lastSuccessfulPrice && now - lastSuccessfulPrice.timestamp < SERVER_STALE_TTL_MS
        ? 'Live SUI price sources failed; returning stale server cache.'
        : 'Live SUI price sources failed; returning fallback SUI price.',
  });
}
