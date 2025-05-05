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

  private constructor() {
    // Load cached price from localStorage on initialization
    this.loadCachedPrice();
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
}

export const priceService = PriceService.getInstance(); 