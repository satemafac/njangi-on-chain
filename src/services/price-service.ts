interface PriceResponse {
  sui: {
    usd: number;
  };
}

class PriceService {
  private static instance: PriceService;
  private lastFetchTime: number = 0;
  private cachedPrice: number | null = null;
  private readonly CACHE_DURATION = 1800000; // 30 minutes cache
  private readonly API_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd';
  private readonly STORAGE_KEY = 'sui_cached_price';
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

  // Force a fresh price fetch regardless of cache
  public async forceRefreshPrice(): Promise<number | null> {
    // Reset the lastFetchTime to force a fresh fetch
    this.lastFetchTime = 0;
    return this.getSUIPrice();
  }

  public async getSUIPrice(): Promise<number | null> {
    const now = Date.now();
    
    // Return cached price if it's still valid
    if (this.cachedPrice !== null && now - this.lastFetchTime < this.CACHE_DURATION) {
      return this.cachedPrice;
    }

    this.fetchStatus = 'loading';
    
    try {
      const response = await fetch(this.API_URL);
      if (!response.ok) {
        throw new Error('Failed to fetch SUI price');
      }

      const data: PriceResponse = await response.json();
      this.cachedPrice = data.sui.usd;
      this.lastFetchTime = now;
      
      // Save to localStorage for persistence
      this.saveCachedPrice(this.cachedPrice, now);
      
      this.fetchStatus = 'success';
      return this.cachedPrice;
    } catch (error) {
      console.error('Error fetching SUI price:', error);
      this.fetchStatus = 'error';
      
      // Return last known price if available, otherwise return null
      return this.cachedPrice;
    }
  }
}

export const priceService = PriceService.getInstance(); 