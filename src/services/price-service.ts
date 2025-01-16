interface PriceResponse {
  sui: {
    usd: number;
  };
}

class PriceService {
  private static instance: PriceService;
  private lastFetchTime: number = 0;
  private cachedPrice: number = 0;
  private readonly CACHE_DURATION = 60000; // 1 minute cache
  private readonly API_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd';

  private constructor() {}

  public static getInstance(): PriceService {
    if (!PriceService.instance) {
      PriceService.instance = new PriceService();
    }
    return PriceService.instance;
  }

  public async getSUIPrice(): Promise<number> {
    const now = Date.now();
    
    // Return cached price if it's still valid
    if (this.cachedPrice && now - this.lastFetchTime < this.CACHE_DURATION) {
      return this.cachedPrice;
    }

    try {
      const response = await fetch(this.API_URL);
      if (!response.ok) {
        throw new Error('Failed to fetch SUI price');
      }

      const data: PriceResponse = await response.json();
      this.cachedPrice = data.sui.usd;
      this.lastFetchTime = now;

      return this.cachedPrice;
    } catch (error) {
      console.error('Error fetching SUI price:', error);
      // Return last known price if available, otherwise fallback to a default
      return this.cachedPrice || 1.25;
    }
  }
}

export const priceService = PriceService.getInstance(); 