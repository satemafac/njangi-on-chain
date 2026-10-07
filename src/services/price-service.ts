import type { SuiPriceReading } from '@/lib/sui-price-reading';

interface ServerPriceResponse {
  success: boolean;
  data?: {
    price: number;
    source?: string;
    stale?: boolean;
    /** The server's hardcoded FALLBACK_PRICE (see pages/api/sui-price.ts). */
    fallback?: boolean;
    /** When a live source last quoted the price (epoch ms). */
    fetchedAt?: number;
  };
  message?: string;
}

type ResolvedPrice = {
  price: number;
  source: string;
  stale: boolean;
  fallback: boolean;
  fetchedAt: number | null;
};

type PriceFetchStatus = 'idle' | 'loading' | 'success' | 'degraded' | 'error';

class PriceService {
  private static instance: PriceService;
  private lastFetchTime: number = 0;
  private cachedPrice: number | null = null;
  private readonly CACHE_DURATION = 300000; // 5 minutes cache (reduced from 30 minutes)
  private readonly SERVER_PRICE_API_URL = '/api/sui-price';
  private readonly STORAGE_KEY = 'sui_cached_price';
  private readonly FALLBACK_PRICE = 3.71; // Current market price as fallback
  private fetchStatus: PriceFetchStatus = 'idle';
  private lastPriceSource: string = 'unavailable';
  private usingStalePrice: boolean = false;
  // Whether the number in hand is a hardcoded fallback (the server's or
  // ours) rather than a quote, and when a live source last quoted it. Both
  // travel with the cached price so a reload cannot launder a fallback into
  // a "cached" quote. Read them through getPriceReading().
  private usingFallbackPrice: boolean = false;
  private priceFetchedAt: number | null = null;

  // Exchange rate properties
  private exchangeRatesCache: Record<string, number> = {};
  private exchangeRatesLastFetch: number = 0;
  private readonly EXCHANGE_RATES_CACHE_DURATION = 3600000; // 1 hour cache for exchange rates
  private readonly EXCHANGE_RATES_STORAGE_KEY = 'exchange_rates_cache';
  private readonly EXCHANGE_RATES_API_URL = 'https://api.exchangerate-api.com/v4/latest/USD';

  // Fallback exchange rates (approximate values as of recent data)
  private readonly FALLBACK_EXCHANGE_RATES: Record<string, number> = {
    USD: 1.0,
    EUR: 0.85,
    GBP: 0.73,
    CAD: 1.25,
    NGN: 1600,
    ZAR: 18.5,
    GHS: 12,
    KES: 130,
    EGP: 31,
    MAD: 10,
    XAF: 600,
  };

  private constructor() {
    // Load cached price from localStorage on initialization
    this.loadCachedPrice();
    this.loadExchangeRatesCache();
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  public static getInstance(): PriceService {
    if (!PriceService.instance) {
      PriceService.instance = new PriceService();
    }
    return PriceService.instance;
  }

  private loadCachedPrice() {
    if (typeof window !== 'undefined') {
      const storedData = localStorage.getItem(this.STORAGE_KEY);
      if (storedData) {
        try {
          const { price, timestamp, source, stale, fallback, fetchedAt } = JSON.parse(storedData);
          this.cachedPrice = price;
          this.lastFetchTime = timestamp;
          this.lastPriceSource = typeof source === 'string' ? source : 'local-cache';
          this.usingStalePrice = stale === true;
          // Entries written before the flag existed named the fallback in
          // their source ('server-fallback' / 'client-fallback').
          this.usingFallbackPrice =
            fallback === true || (typeof source === 'string' && /fallback/i.test(source));
          this.priceFetchedAt =
            typeof fetchedAt === 'number' && Number.isFinite(fetchedAt) ? fetchedAt : null;
        } catch (e) {
          console.warn(`Error parsing cached price data: ${this.getErrorMessage(e)}`);
        }
      }
    }
  }

  private saveCachedPrice(
    price: number,
    timestamp: number,
    source: string,
    stale: boolean,
    fallback: boolean,
    fetchedAt: number | null,
  ) {
    if (typeof window !== 'undefined') {
      localStorage.setItem(
        this.STORAGE_KEY,
        JSON.stringify({ price, timestamp, source, stale, fallback, fetchedAt })
      );
    }
  }

  public getFetchStatus(): PriceFetchStatus {
    return this.fetchStatus;
  }

  public isPriceStale(): boolean {
    return this.usingStalePrice;
  }

  public getLastPriceSource(): string {
    return this.lastPriceSource;
  }

  public isPriceAvailable(): boolean {
    return this.cachedPrice !== null;
  }

  /** The number in hand is a hardcoded fallback, not a quote. */
  public isPriceFallback(): boolean {
    return this.usingFallbackPrice;
  }

  /**
   * The price in hand with its provenance, for callers that must know
   * whether it is a quote (isUsableSuiPrice in src/lib/sui-price-reading.ts).
   */
  public getPriceReading(): SuiPriceReading {
    return {
      price: this.cachedPrice,
      source: this.lastPriceSource,
      stale: this.usingStalePrice,
      fallback: this.usingFallbackPrice,
      fetchedAt: this.priceFetchedAt,
    };
  }

  public getCachedPrice(): number | null {
    return this.cachedPrice;
  }

  // Force a fresh price fetch regardless of cache
  public async forceRefreshPrice(): Promise<number | null> {
    // Reset the lastFetchTime to force a fresh fetch
    this.lastFetchTime = 0;
    return this.getSUIPrice();
  }

  private async fetchServerPrice(): Promise<ResolvedPrice | null> {
    try {
      const response = await fetch(this.SERVER_PRICE_API_URL, {
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Local price API returned ${response.status}`);
      }

      const data: ServerPriceResponse = await response.json();
      if (data.success && data.data?.price) {
        if (data.data.source) {
          console.log(`Successfully fetched SUI price from local API (${data.data.source}): $${data.data.price}`);
        }
        const stale = data.data.stale === true;
        const fallback = data.data.fallback === true;
        return {
          price: data.data.price,
          source: data.data.source || 'local-api',
          stale,
          fallback,
          // A live answer without the field (an older server) is as fresh as
          // this request; a stale one of unknown age stays unknown.
          fetchedAt:
            typeof data.data.fetchedAt === 'number' && Number.isFinite(data.data.fetchedAt)
              ? data.data.fetchedAt
              : !fallback && !stale
                ? Date.now()
                : null,
        };
      }

      if (data.message) {
        console.warn(`Local price API did not return a live price: ${data.message}`);
      }

      return null;
    } catch (error) {
      console.warn(`Error fetching SUI price from local API: ${this.getErrorMessage(error)}`);
      return null;
    }
  }

  public async getSUIPrice(): Promise<number | null> {
    const now = Date.now();
    
    // Return cached price if it's still valid and not too old
    if (this.cachedPrice !== null && 
        now - this.lastFetchTime < this.CACHE_DURATION) {
      console.log(`Using cached SUI price: $${this.cachedPrice} (${Math.floor((now - this.lastFetchTime)/1000)}s old)`);
      this.fetchStatus = this.usingStalePrice ? 'degraded' : 'success';
      return this.cachedPrice;
    }

    this.fetchStatus = 'loading';
    
    // Use a same-origin API route to avoid browser CORS failures.
    try {
      const result = await this.fetchServerPrice();
      if (result === null) {
        throw new Error('No live SUI price available from local API');
      }

      this.cachedPrice = result.price;
      this.lastFetchTime = now;
      this.lastPriceSource = result.source;
      this.usingStalePrice = result.stale;
      this.usingFallbackPrice = result.fallback;
      this.priceFetchedAt = result.fetchedAt;
      
      // Save to localStorage for persistence
      this.saveCachedPrice(
        this.cachedPrice,
        now,
        this.lastPriceSource,
        this.usingStalePrice,
        this.usingFallbackPrice,
        this.priceFetchedAt,
      );
      
      this.fetchStatus = result.stale ? 'degraded' : 'success';
      console.log(`Successfully resolved SUI price: $${this.cachedPrice} (source: ${this.lastPriceSource})`);
      return this.cachedPrice;
    } catch (primaryError) {
      console.warn(`Error fetching SUI price from live sources: ${this.getErrorMessage(primaryError)}`);

      // If we have a recently cached price (within 6 hours), use that
      if (this.cachedPrice !== null && now - this.lastFetchTime < 6 * 60 * 60 * 1000) {
        this.fetchStatus = 'degraded';
        this.usingStalePrice = true;
        this.lastPriceSource = `${this.lastPriceSource || 'local-cache'} (client-stale-cache)`;
        this.lastFetchTime = now;
        // usingFallbackPrice and priceFetchedAt describe the number we keep.
        console.warn(`Using stale cached price: $${this.cachedPrice}`);
        this.saveCachedPrice(
          this.cachedPrice,
          now,
          this.lastPriceSource,
          true,
          this.usingFallbackPrice,
          this.priceFetchedAt,
        );
        return this.cachedPrice;
      }
      
      // Use fallback price if we don't have any cached price or it's too old
      if (this.cachedPrice === null || now - this.lastFetchTime > 6 * 60 * 60 * 1000) {
        this.fetchStatus = 'degraded';
        this.usingStalePrice = true;
        this.lastPriceSource = 'client-fallback';
        this.usingFallbackPrice = true;
        this.priceFetchedAt = null;
        console.warn(`Using fallback price: $${this.FALLBACK_PRICE}`);
        this.cachedPrice = this.FALLBACK_PRICE;
        this.lastFetchTime = now;
        this.saveCachedPrice(this.cachedPrice, now, this.lastPriceSource, true, true, null);
        return this.cachedPrice;
      }

      this.fetchStatus = 'error';
      return this.cachedPrice;
    }
  }

  private loadExchangeRatesCache() {
    if (typeof window !== 'undefined') {
      const storedData = localStorage.getItem(this.EXCHANGE_RATES_STORAGE_KEY);
      if (storedData) {
        try {
          const { rates, timestamp } = JSON.parse(storedData);
          this.exchangeRatesCache = rates;
          this.exchangeRatesLastFetch = timestamp;
        } catch (e) {
          console.warn(`Error parsing exchange rates cache data: ${this.getErrorMessage(e)}`);
        }
      }
    }
  }

  private saveExchangeRatesCache(exchangeRates: Record<string, number>) {
    if (typeof window !== 'undefined') {
      const timestamp = Date.now();
      localStorage.setItem(
        this.EXCHANGE_RATES_STORAGE_KEY,
        JSON.stringify({ rates: exchangeRates, timestamp })
      );
    }
  }

  public getExchangeRatesCache(): Record<string, number> {
    return this.exchangeRatesCache;
  }

  public getExchangeRatesLastFetch(): number {
    return this.exchangeRatesLastFetch;
  }

  private async fetchExchangeRates(): Promise<Record<string, number> | null> {
    try {
      const response = await fetch(this.EXCHANGE_RATES_API_URL);
      if (!response.ok) {
        throw new Error('Failed to fetch exchange rates');
      }
      const data = await response.json();
      if (data && data.rates) {
        return data.rates;
      }
      return null;
    } catch (error) {
      console.warn(`Error fetching exchange rates: ${this.getErrorMessage(error)}`);
      return null;
    }
  }

  public async getExchangeRate(currency: string): Promise<number> {
    if (currency === 'USD') return 1.0;

    const now = Date.now();
    
    // Check if we have cached rates and they're still valid
    if (this.exchangeRatesCache[currency] && 
        now - this.exchangeRatesLastFetch < this.EXCHANGE_RATES_CACHE_DURATION) {
      console.log(`Using cached exchange rate for ${currency}: ${this.exchangeRatesCache[currency]}`);
      return this.exchangeRatesCache[currency];
    }

    // Try to fetch fresh rates
    const freshRates = await this.fetchExchangeRates();
    if (freshRates && freshRates[currency]) {
      this.exchangeRatesCache = { ...this.exchangeRatesCache, ...freshRates };
      this.exchangeRatesLastFetch = now;
      this.saveExchangeRatesCache(this.exchangeRatesCache);
      console.log(`Successfully fetched exchange rate for ${currency}: ${freshRates[currency]}`);
      return freshRates[currency];
    }

    // Fall back to cached rate if available (even if stale)
    if (this.exchangeRatesCache[currency]) {
      console.warn(`Using stale cached exchange rate for ${currency}: ${this.exchangeRatesCache[currency]}`);
      return this.exchangeRatesCache[currency];
    }

    // Fall back to hardcoded rates
    if (this.FALLBACK_EXCHANGE_RATES[currency]) {
      console.warn(`Using fallback exchange rate for ${currency}: ${this.FALLBACK_EXCHANGE_RATES[currency]}`);
      return this.FALLBACK_EXCHANGE_RATES[currency];
    }

    console.error(`No exchange rate available for ${currency}`);
    return 1.0; // Default to 1:1 if all else fails
  }

  public async convertToUSD(amount: number, fromCurrency: string): Promise<number> {
    if (fromCurrency === 'USD') return amount;
    
    const exchangeRate = await this.getExchangeRate(fromCurrency);
    return amount / exchangeRate;
  }

  public async convertFromUSD(amount: number, toCurrency: string): Promise<number> {
    if (toCurrency === 'USD') return amount;
    
    const exchangeRate = await this.getExchangeRate(toCurrency);
    return amount * exchangeRate;
  }

  public async getSUIPriceInCurrency(currency: string): Promise<number | null> {
    const suiPriceUSD = await this.getSUIPrice();
    if (suiPriceUSD === null) return null;
    
    if (currency === 'USD') return suiPriceUSD;
    
    return await this.convertFromUSD(suiPriceUSD, currency);
  }

  public async convertCurrencyToSUI(amount: number, currency: string): Promise<number> {
    const suiPriceInCurrency = await this.getSUIPriceInCurrency(currency);
    if (suiPriceInCurrency === null) {
      console.error(`Unable to get SUI price in ${currency}`);
      return 0;
    }
    
    return amount / suiPriceInCurrency;
  }
}

export const priceService = PriceService.getInstance(); 
