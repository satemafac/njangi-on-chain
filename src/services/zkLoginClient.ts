import { AccountData } from './zkLoginService';
import type { OAuthProvider } from './zkLoginService';

// Custom error class for zkLogin errors that includes requireRelogin property
export class ZkLoginError extends Error {
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

  public async deleteCircle(account: AccountData, circleId: string): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      // Log key information for debugging
      console.log('ZkLoginClient: Deleting circle with account:', {
        address: account.userAddr,
        circleId: circleId,
        hasProofPoints: !!account.zkProofs?.proofPoints,
        hasIssBase64Details: !!account.zkProofs?.issBase64Details,
        hasHeaderBase64: !!account.zkProofs?.headerBase64,
        maxEpoch: account.maxEpoch
      });

      // Verify the account has valid proof data
      if (!account.zkProofs?.proofPoints || 
          !account.zkProofs.issBase64Details || 
          !account.zkProofs.headerBase64) {
        throw new ZkLoginError(
          'Missing required authentication data. Please login again.',
          true
        );
      }

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'deleteCircle', 
          account,
          circleId
        })
      });
      
      // Try to parse the response even if status is not OK
      let responseData;
      try {
        responseData = await response.json();
        console.log('ZkLoginClient: Circle deletion response:', 
          response.status, response.statusText, responseData);
      } catch (parseError) {
        console.error('Failed to parse response:', parseError);
        throw new ZkLoginError(`Failed to parse server response: ${response.statusText}`, false);
      }
      
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
        console.error('Circle deletion failed:', responseData);
        
        // Check for specific contract errors
        const errorMsg = responseData.error || 'Circle deletion failed';
        
        if (errorMsg.includes('ECircleHasActiveMembers') || 
            errorMsg.includes('ECircleHasContributions') ||
            errorMsg.includes('EOnlyCircleAdmin')) {
          // These are expected contract error conditions, not authentication errors
          throw new ZkLoginError(errorMsg, false);
        }
        
        throw new ZkLoginError(
          errorMsg, 
          !!responseData.requireRelogin
        );
      }
      
      // Even for successful response, check if we have a digest
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      
      console.log('ZkLoginClient: Circle deletion succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('ZkLoginClient: Circle deletion error:', error);
      
      // Rethrow ZkLoginError as is
      if (error instanceof ZkLoginError) {
        throw error;
      }
      
      // Otherwise wrap in a new error
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('ZkLoginClient: Non-ZkLoginError occurred:', errorMessage);
      throw new ZkLoginError(errorMessage, false);
    }
  }

  public async activateCircle(account: AccountData, circleId: string): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      // Log key information for debugging
      console.log('ZkLoginClient: Activating circle with account:', {
        address: account.userAddr,
        circleId: circleId,
        hasProofPoints: !!account.zkProofs?.proofPoints,
        hasIssBase64Details: !!account.zkProofs?.issBase64Details,
        hasHeaderBase64: !!account.zkProofs?.headerBase64,
        maxEpoch: account.maxEpoch
      });

      // Verify the account has valid proof data
      if (!account.zkProofs?.proofPoints || 
          !account.zkProofs.issBase64Details || 
          !account.zkProofs.headerBase64) {
        throw new ZkLoginError(
          'Missing required authentication data. Please login again.',
          true
        );
      }

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'activateCircle', 
          account,
          circleId
        })
      });
      
      // Try to parse the response even if status is not OK
      let responseData;
      try {
        responseData = await response.json();
        console.log('ZkLoginClient: Circle activation response:', 
          response.status, response.statusText, responseData);
      } catch (parseError) {
        console.error('Failed to parse response:', parseError);
        throw new ZkLoginError(`Failed to parse server response: ${response.statusText}`, false);
      }
      
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
        console.error('Circle activation failed:', responseData);
        throw new ZkLoginError(
          responseData.error || 'Circle activation failed', 
          !!responseData.requireRelogin
        );
      }
      
      // Even for successful response, check if we have a digest
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      
      console.log('Circle activation succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('Circle activation error in client:', error);
      // Rethrow ZkLoginError as is
      if (error instanceof ZkLoginError) {
        throw error;
      }
      // Otherwise wrap in a new error
      throw new ZkLoginError(String(error), false);
    }
  }

  public async paySecurityDeposit(account: AccountData, walletId: string, depositAmount: number): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      // Log key information for debugging
      console.log('ZkLoginClient: Paying security deposit with account:', {
        address: account.userAddr,
        walletId: walletId,
        depositAmount: depositAmount,
        hasProofPoints: !!account.zkProofs?.proofPoints,
        hasIssBase64Details: !!account.zkProofs?.issBase64Details,
        hasHeaderBase64: !!account.zkProofs?.headerBase64,
        maxEpoch: account.maxEpoch
      });

      // Verify the account has valid proof data
      if (!account.zkProofs?.proofPoints || 
          !account.zkProofs.issBase64Details || 
          !account.zkProofs.headerBase64) {
        throw new ZkLoginError(
          'Missing required authentication data. Please login again.',
          true
        );
      }

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'paySecurityDeposit',
          account,
          walletId,
          depositAmount
        })
      });
      
      // Try to parse the response even if status is not OK
      let responseData;
      try {
        responseData = await response.json();
        console.log('ZkLoginClient: Security deposit payment response:', 
          response.status, response.statusText, responseData);
      } catch (parseError) {
        console.error('Failed to parse response:', parseError);
        throw new ZkLoginError(`Failed to parse server response: ${response.statusText}`, false);
      }
      
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
        console.error('Security deposit payment failed:', responseData);
        throw new ZkLoginError(
          responseData.error || 'Security deposit payment failed', 
          !!responseData.requireRelogin
        );
      }
      
      // Even for successful response, check if we have a digest
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      
      console.log('Security deposit payment succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('Security deposit payment error in client:', error);
      // Rethrow ZkLoginError as is
      if (error instanceof ZkLoginError) {
        throw error;
      }
      // Otherwise wrap in a new error
      throw new ZkLoginError(String(error), false);
    }
  }

  /**
   * Configure stablecoin swap settings for a custody wallet
   * @param account ZkLogin account data
   * @param walletId The custody wallet ID
   * @param config Configuration settings for stablecoin swaps
   */
  public async configureStablecoinSwap(
    account: AccountData, 
    walletId: string,
    config: {
      enabled: boolean;
      targetCoinType: 'USDC' | 'USDT';
      slippageTolerance: number; 
      minimumSwapAmount: number;
    }
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      console.log('Configuring stablecoin swap with account:', {
        address: account.userAddr,
        walletId,
        config
      });
      
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'configureStablecoinSwap',
          account,
          walletId,
          config
        })
      });
      
      const responseData: ZkLoginResponse = await response.json();
      
      // Handle authentication errors
      if (response.status === 401) {
        console.error('Authentication error:', responseData);
        throw new ZkLoginError(
          `Authentication error: ${responseData.error || 'Session expired'}. Please login again.`,
          true
        );
      }
      
      // Handle server errors
      if (!response.ok) {
        console.error('Stablecoin configuration failed:', responseData);
        throw new ZkLoginError(
          responseData.error || 'Stablecoin configuration failed',
          !!responseData.requireRelogin
        );
      }
      
      // Check digest
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      
      console.log('Stablecoin configuration succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('Stablecoin configuration error:', error);
      if (error instanceof ZkLoginError) {
        throw error;
      }
      throw new ZkLoginError(String(error), false);
    }
  }

  public async setRotationPosition(
    account: AccountData, 
    circleId: string,
    memberAddress: string,
    position: number
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      // Ensure address is in the correct format for the smart contract
      // First, strip any leading 0x if present
      const cleanAddress = memberAddress.toLowerCase().replace(/^0x/, '');
      // Then ensure it has 0x prefix for the API call
      const normalizedMemberAddress = `0x${cleanAddress}`;
      
      // Log key information for debugging
      console.log('Setting rotation position with:', {
        sender: account.userAddr,
        circleId,
        rawMemberAddress: memberAddress,
        normalizedMemberAddress,
        position,
        hasProofPoints: !!account.zkProofs?.proofPoints,
        hasIssBase64Details: !!account.zkProofs?.issBase64Details,
        hasHeaderBase64: !!account.zkProofs?.headerBase64,
        maxEpoch: account.maxEpoch
      });

      // Verify the account has valid proof data
      if (!account.zkProofs?.proofPoints || 
          !account.zkProofs.issBase64Details || 
          !account.zkProofs.headerBase64) {
        throw new ZkLoginError(
          'Missing required authentication data. Please login again.',
          true
        );
      }

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'setRotationPosition', 
          account,
          circleId,
          memberAddress: normalizedMemberAddress,
          position
        })
      });
      
      // Try to parse the response even if status is not OK
      let responseData;
      try {
        responseData = await response.json();
        console.log('ZkLoginClient: Set rotation position response:', 
          response.status, response.statusText, responseData);
      } catch (parseError) {
        console.error('Failed to parse response:', parseError);
        throw new ZkLoginError(`Failed to parse server response: ${response.statusText}`, false);
      }
      
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
        console.error('Set rotation position failed:', responseData);
        
        // Check if this is a business logic error (HTTP 400)
        if (response.status === 400 && responseData.error) {
          throw new Error(responseData.error);
        }
        
        throw new ZkLoginError(
          responseData.error || 'Failed to set rotation position', 
          !!responseData.requireRelogin
        );
      }
      
      // Even for successful response, check if we have a digest
      if (!responseData.digest) {
        throw new ZkLoginError('No transaction digest received from server', false);
      }
      
      console.log('Set rotation position succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('Set rotation position error in client:', error);
      // Rethrow ZkLoginError as is
      if (error instanceof ZkLoginError) {
        throw error;
      }
      // Otherwise wrap in a new error
      throw new ZkLoginError(String(error), false);
    }
  }

  /**
   * Reorder all rotation positions in one transaction
   * @param account ZkLogin account data
   * @param circleId The circle ID
   * @param newOrder Array of member addresses in the desired order
   */
  public async reorderRotationPositions(
    account: AccountData, 
    circleId: string,
    newOrder: string[]
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      // Log key information for debugging
      console.log('ZkLoginClient: Reordering rotation positions with account:', {
        address: account.userAddr,
        circleId,
        newOrderLength: newOrder.length,
        hasProofPoints: !!account.zkProofs?.proofPoints,
        hasHeaderBase64: !!account.zkProofs?.headerBase64,
        maxEpoch: account.maxEpoch
      });

      // Verify the account has valid proof data
      if (!account.zkProofs?.proofPoints || 
          !account.zkProofs.issBase64Details || 
          !account.zkProofs.headerBase64) {
        throw new ZkLoginError(
          'Missing required authentication data. Please login again.',
          true
        );
      }

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'reorderRotationPositions', 
          account,
          circleId,
          newOrder
        })
      });
      
      // Try to parse the response even if status is not OK
      let responseData;
      try {
        responseData = await response.json();
      } catch (parseError) {
        console.error('Failed to parse response:', parseError);
        throw new ZkLoginError(`Failed to parse server response: ${response.statusText}`, false);
      }
      
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
      
      console.log('Reorder rotation positions succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('Reorder rotation positions error in client:', error);
      // Rethrow ZkLoginError as is
      if (error instanceof ZkLoginError) {
        throw error;
      }
      // Otherwise wrap in a new error
      throw new ZkLoginError(String(error), false);
    }
  }

  public async adminApproveMembers(
    account: AccountData, 
    circleId: string,
    memberAddresses: string[]
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      // Log key information for debugging
      console.log('ZkLoginClient: Approving multiple members with account:', {
        address: account.userAddr,
        circleId,
        memberCount: memberAddresses.length,
        hasProofPoints: !!account.zkProofs?.proofPoints,
        hasHeaderBase64: !!account.zkProofs?.headerBase64,
        maxEpoch: account.maxEpoch
      });

      // Verify the account has valid proof data
      if (!account.zkProofs?.proofPoints || 
          !account.zkProofs.issBase64Details || 
          !account.zkProofs.headerBase64) {
        throw new ZkLoginError(
          'Missing required authentication data. Please login again.',
          true
        );
      }

      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          action: 'adminApproveMembers', 
          account,
          circleId,
          memberAddresses
        })
      });
      
      // Try to parse the response even if status is not OK
      let responseData;
      try {
        responseData = await response.json();
      } catch (parseError) {
        console.error('Failed to parse response:', parseError);
        throw new ZkLoginError(`Failed to parse server response: ${response.statusText}`, false);
      }
      
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
      
      console.log('Approve multiple members succeeded:', responseData);
      return {
        digest: responseData.digest,
        requireRelogin: responseData.requireRelogin
      };
    } catch (error) {
      console.error('Approve multiple members error in client:', error);
      // Rethrow ZkLoginError as is
      if (error instanceof ZkLoginError) {
        throw error;
      }
      // Otherwise wrap in a new error
      throw new ZkLoginError(String(error), false);
    }
  }

  /**
   * Trigger automatic payout for a circle
   */
  async adminTriggerPayout(
    account: AccountData,
    circleId: string,
    walletId: string
  ): Promise<{ digest: string; requireRelogin?: boolean }> {
    try {
      const response = await fetch('/api/zkLogin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'adminTriggerPayout',
          account,
          circleId,
          walletId
        }),
      });
      
      // Check for HTTP error responses
      if (!response.ok) {
        const errorData = await response.json();
        throw new ZkLoginError(
          errorData.error || 'Failed to trigger payout',
          errorData.requireRelogin || false
        );
      }
      
      const result = await response.json();
      return { 
        digest: result.digest,
        requireRelogin: result.requireRelogin
      };
    } catch (error) {
      // Handle errors that aren't HTTP errors
      if (!(error instanceof ZkLoginError)) {
        console.error('Error in adminTriggerPayout:', error);
        throw new ZkLoginError(
          error instanceof Error ? error.message : 'Unknown error triggering payout',
          false
        );
      }
      throw error;
    }
  }
} 