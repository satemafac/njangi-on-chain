interface PriceResponse {
  sui: {
    usd: number;
  };
}

class PriceService {
  private static instance: PriceService;
  private lastFetchTime: number = 0;
  private cachedPrice: number | null = null;
  private readonly CACHE_DURATION = 300000; // 5 minutes cache (reduced from 30 minutes)
  // Primary API - CoinGecko with API key if available
  private readonly PRIMARY_API_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd';
  // Backup APIs
  private readonly BACKUP_API_URL = 'https://price.jup.ag/v4/price?ids=SUI';
  private readonly BINANCE_API_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT';
  private readonly STORAGE_KEY = 'sui_cached_price';
  private readonly FALLBACK_PRICE = 3.71; // Current market price as fallback
  private fetchStatus: 'idle' | 'loading' | 'success' | 'error' = 'idle';

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
          const { price, timestamp } = JSON.parse(storedData);
          this.cachedPrice = price;
          this.lastFetchTime = timestamp;
        } catch (e) {
          console.error('Error parsing cached price data:', e);
        }
      }
    }
  }

  private saveCachedPrice(price: number, timestamp: number) {
    if (typeof window !== 'undefined') {
      localStorage.setItem(
        this.STORAGE_KEY,
        JSON.stringify({ price, timestamp })
      );
    }
  }

  public getFetchStatus(): 'idle' | 'loading' | 'success' | 'error' {
    return this.fetchStatus;
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

  // Try Binance API as a fallback
  private async fetchBinancePrice(): Promise<number | null> {
    try {
      const response = await fetch(this.BINANCE_API_URL);
      if (!response.ok) {
        throw new Error('Failed to fetch from Binance');
      }
      const data = await response.json();
      if (data && data.price) {
        return parseFloat(data.price);
      }
      return null;
    } catch (error) {
      console.error('Error fetching from Binance:', error);
      return null;
    }
  }

  // Try Jupiter price API as a fallback
  private async fetchJupiterPrice(): Promise<number | null> {
    try {
      const response = await fetch(this.BACKUP_API_URL);
      if (!response.ok) {
        throw new Error('Failed to fetch from Jupiter');
      }
      const data = await response.json();
      if (data && data.data && data.data.SUI) {
        return data.data.SUI.price;
      }
      return null;
    } catch (error) {
      console.error('Error fetching from Jupiter:', error);
      return null;
    }
  }

  public async getSUIPrice(): Promise<number | null> {
    const now = Date.now();
    
    // Return cached price if it's still valid and not too old
    if (this.cachedPrice !== null && 
        now - this.lastFetchTime < this.CACHE_DURATION) {
      console.log(`Using cached SUI price: $${this.cachedPrice} (${Math.floor((now - this.lastFetchTime)/1000)}s old)`);
      return this.cachedPrice;
    }

    this.fetchStatus = 'loading';
    
    // Try primary API first
    try {
      const response = await fetch(this.PRIMARY_API_URL);
      if (!response.ok) {
        throw new Error('Failed to fetch SUI price from primary API');
      }

      const data: PriceResponse = await response.json();
      this.cachedPrice = data.sui.usd;
      this.lastFetchTime = now;
      
      // Save to localStorage for persistence
      this.saveCachedPrice(this.cachedPrice, now);
      
      this.fetchStatus = 'success';
      console.log(`Successfully fetched fresh SUI price: $${this.cachedPrice}`);
      return this.cachedPrice;
    } catch (primaryError) {
      console.error('Error fetching SUI price from primary API:', primaryError);
      
      // Try Jupiter price API
      const jupiterPrice = await this.fetchJupiterPrice();
      if (jupiterPrice !== null) {
        this.cachedPrice = jupiterPrice;
        this.lastFetchTime = now;
        this.saveCachedPrice(this.cachedPrice, now);
        this.fetchStatus = 'success';
        console.log(`Successfully fetched SUI price from Jupiter: $${this.cachedPrice}`);
        return this.cachedPrice;
      }
      
      // Try Binance API
      const binancePrice = await this.fetchBinancePrice();
      if (binancePrice !== null) {
        this.cachedPrice = binancePrice;
        this.lastFetchTime = now;
        this.saveCachedPrice(this.cachedPrice, now);
        this.fetchStatus = 'success';
        console.log(`Successfully fetched SUI price from Binance: $${this.cachedPrice}`);
        return this.cachedPrice;
      }
      
      this.fetchStatus = 'error';
      
      // If we have a recently cached price (within 6 hours), use that
      if (this.cachedPrice !== null && now - this.lastFetchTime < 6 * 60 * 60 * 1000) {
        console.warn(`Using stale cached price: $${this.cachedPrice}`);
        return this.cachedPrice;
      }
      
      // Use fallback price if we don't have any cached price or it's too old
      if (this.cachedPrice === null || now - this.lastFetchTime > 6 * 60 * 60 * 1000) {
        console.warn(`Using fallback price: $${this.FALLBACK_PRICE}`);
        this.cachedPrice = this.FALLBACK_PRICE;
        this.lastFetchTime = now;
        this.saveCachedPrice(this.cachedPrice, now);
        return this.cachedPrice;
      }
      
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
          console.error('Error parsing exchange rates cache data:', e);
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
      console.error('Error fetching exchange rates:', error);
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