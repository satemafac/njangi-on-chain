interface ServerPriceResponse {
  success: boolean;
  data?: {
    price: number;
    source?: string;
    stale?: boolean;
  };
  message?: string;
}

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
          const { price, timestamp, source, stale } = JSON.parse(storedData);
          this.cachedPrice = price;
          this.lastFetchTime = timestamp;
          this.lastPriceSource = typeof source === 'string' ? source : 'local-cache';
          this.usingStalePrice = stale === true;
        } catch (e) {
          console.warn(`Error parsing cached price data: ${this.getErrorMessage(e)}`);
        }
      }
    }
  }

  private saveCachedPrice(price: number, timestamp: number, source: string, stale: boolean) {
    if (typeof window !== 'undefined') {
      localStorage.setItem(
        this.STORAGE_KEY,
        JSON.stringify({ price, timestamp, source, stale })
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

  public getCachedPrice(): number | null {
    return this.cachedPrice;
  }

  // Force a fresh price fetch regardless of cache
  public async forceRefreshPrice(): Promise<number | null> {
    // Reset the lastFetchTime to force a fresh fetch
    this.lastFetchTime = 0;
    return this.getSUIPrice();
  }

  private async fetchServerPrice(): Promise<{ price: number; source: string; stale: boolean } | null> {
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
        return {
          price: data.data.price,
          source: data.data.source || 'local-api',
          stale: data.data.stale === true,
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
      
      // Save to localStorage for persistence
      this.saveCachedPrice(this.cachedPrice, now, this.lastPriceSource, this.usingStalePrice);
      
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
        console.warn(`Using stale cached price: $${this.cachedPrice}`);
        this.saveCachedPrice(this.cachedPrice, now, this.lastPriceSource, true);
        return this.cachedPrice;
      }
      
      // Use fallback price if we don't have any cached price or it's too old
      if (this.cachedPrice === null || now - this.lastFetchTime > 6 * 60 * 60 * 1000) {
        this.fetchStatus = 'degraded';
        this.usingStalePrice = true;
        this.lastPriceSource = 'client-fallback';
        console.warn(`Using fallback price: $${this.FALLBACK_PRICE}`);
        this.cachedPrice = this.FALLBACK_PRICE;
        this.lastFetchTime = now;
        this.saveCachedPrice(this.cachedPrice, now, this.lastPriceSource, true);
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
