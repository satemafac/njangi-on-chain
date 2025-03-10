import { AccountData } from './zkLoginService';
import type { OAuthProvider } from './zkLoginService';

// Custom error class for zkLogin errors that includes requireRelogin property
class ZkLoginError extends Error {
  requireRelogin: boolean;
  
  constructor(message: string, requireRelogin: boolean = false) {
    super(message);
    this.requireRelogin = requireRelogin;
    this.name = 'ZkLoginError';
  }
}

interface ZkLoginResponse {
  error?: string;
  details?: string;
  requireRelogin?: boolean;
  digest?: string;
  status?: 'success' | 'failure';
  gasUsed?: {
    computationCost: string;
    storageCost: string;
    storageRebate: string;
  };
}

interface CircleData {
  name: string;
  contribution_amount: string | number;
  security_deposit: string | number;
  cycle_length: number;
  cycle_day: number;
  circle_type: number;
  max_members: number;
  rotation_style: number;
  penalty_rules: boolean[];
  goal_type?: { some?: number };
  target_amount?: { some?: string | number };
  target_date?: { some?: string | number };
  verification_required: boolean;
}

export class ZkLoginClient {
  private static instance: ZkLoginClient;

  public static getInstance(): ZkLoginClient {
    if (!ZkLoginClient.instance) {
      ZkLoginClient.instance = new ZkLoginClient();
    }
    return ZkLoginClient.instance;
  }

  public async beginLogin(provider: OAuthProvider = 'Google'): Promise<{ loginUrl: string }> {
    const response = await fetch('/api/zkLogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'beginLogin', provider })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to begin login: ${errorText}`);
    }

    const data = await response.json();
    if (!data.loginUrl) {
      throw new Error('No login URL returned from server');
    }

    return data;
  }

  public async handleCallback(jwt: string): Promise<AccountData> {
    // Set up a retry mechanism with backoff
    let retries = 0;
    const maxRetries = 3;
    const baseBackoff = 1500; // 1.5 seconds base
    
    while (true) {
      try {
        const response = await fetch('/api/zkLogin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'handleCallback', jwt })
        });
        
        // Handle processing status (202)
        if (response.status === 202) {
          const data = await response.json();
          
          // Only log on first retry
          if (retries === 0) {
            console.log('Authentication processing:', data.message);
          }
          
          retries++;
          
          // If we've tried too many times, throw an error
          if (retries > maxRetries) {
            throw new Error('Authentication is taking too long. Please try again.');
          }
          
          // Exponential backoff with jitter
          const jitter = Math.random() * 500;
          const backoff = baseBackoff * Math.pow(1.5, retries) + jitter;
          
          console.log(`Retry ${retries}/${maxRetries} after ${Math.round(backoff)}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue; // Try again
        }
        
        // Handle other errors
        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to process authentication');
        }
        
        // Success - return the account data
        return response.json();
      } catch (err) {
        // If we've hit our retry limit or received a non-processing error, rethrow
        if (retries > maxRetries || !(err instanceof Error && err.message.includes('taking too long'))) {
          throw err;
        }
        
        // Otherwise, try again after backoff
        const backoff = baseBackoff * Math.pow(1.5, retries) + (Math.random() * 500);
        await new Promise(resolve => setTimeout(resolve, backoff));
        retries++;
      }
    }
  }

  public async sendTransaction(account: AccountData, circleData: CircleData): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      // Log key information for debugging
      console.log('Sending transaction with account:', {
        address: account.userAddr,
        hasProofPoints: !!account.zkProofs?.proofPoints,
        hasIssBase64Details: !!account.zkProofs?.issBase64Details,
        hasHeaderBase64: !!account.zkProofs?.headerBase64,
        maxEpoch: account.maxEpoch
      });

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'sendTransaction', 
          account,
          circleData
        })
      });
      
      const responseData: ZkLoginResponse = await response.json();
      
      // Handle authentication errors (401)
      if (response.status === 401) {
        console.error('Authentication error:', responseData);
        throw new ZkLoginError(
          `Authentication error: ${responseData.error || 'Session expired'}. Please login again.`, 
          true
        );
      }
      
      // Handle server errors (500)
      if (!response.ok) {
        console.error('Transaction failed:', responseData);
        throw new ZkLoginError(
          responseData.error || 'Transaction failed', 
          !!responseData.requireRelogin
        );
      }
      
      // Even for successful response, check if we have a digest
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      
      console.log('Transaction succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('Transaction error in client:', error);
      // Rethrow ZkLoginError as is
      if (error instanceof ZkLoginError) {
        throw error;
      }
      // Otherwise wrap in a new error
      throw new ZkLoginError(String(error), false);
    }
  }
} 