import { NextApiRequest, NextApiResponse } from 'next';
import { SuiClient } from '@mysten/sui/client';
import { enokiZkLoginService } from '@/services/enokiZkLoginService';
import { AccountData, SetupData } from '@/services/zkLoginService';
import fs from 'fs';

// Use the same session structure as the main zkLogin API
type SessionData = SetupData & { account?: AccountData };

// Use the same session management as zkLogin.ts
const sessions = (() => {
  const sessionData = new Map<string, SessionData>();
  const SESSION_FILE = './zklogin-sessions.json';
  
  // Try to load existing sessions from file (same as zkLogin.ts)
  try {
    if (process.env.NODE_ENV === 'development' && fs.existsSync(SESSION_FILE)) {
      const savedSessions = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      if (savedSessions && typeof savedSessions === 'object') {
        Object.entries(savedSessions).forEach(([key, value]) => {
          sessionData.set(key, value as SessionData);
        });
        console.log(`Transfer API: Loaded ${sessionData.size} sessions from disk`);
      }
    }
  } catch (err) {
    console.error('Transfer API: Error loading sessions from disk:', err);
  }

  return {
    get: (key: string) => sessionData.get(key),
    has: (key: string) => sessionData.has(key),
    delete: (key: string) => sessionData.delete(key),
  };
})();

const MAX_EPOCH = 2; // Same as zkLogin.ts

function validateSession(sessionId: string | undefined, operation: string): SessionData {
  if (!sessionId) {
    throw new Error('No session ID provided');
  }

  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found for ${operation}`);
  }

  // Use the same validation logic as zkLogin.ts
  if (!session.ephemeralPrivateKey) {
    throw new Error('Invalid session: missing ephemeral key');
  }
  if (!session.account) {
    throw new Error('Invalid session: missing account data');
  }
  
  // Validate proof expiration
  if (session.maxEpoch) {
    const currentEpoch = Math.floor(Number(session.maxEpoch) - MAX_EPOCH);
    const maxEpoch = Number(session.maxEpoch);
    
    if (currentEpoch >= maxEpoch) {
      sessions.delete(sessionId);
      throw new Error('Session has expired. Please login again.');
    }
  }

  // Validate proof components
  if (!session.account.zkProofs?.proofPoints?.a?.length ||
      !session.account.zkProofs?.proofPoints?.b?.length ||
      !session.account.zkProofs?.proofPoints?.c?.length) {
    throw new Error('Invalid session: missing or invalid proof points');
  }

  return session;
}

function clearSessionCookie(res: NextApiResponse) {
  res.setHeader('Set-Cookie', 'session-id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
}

function isValidSuiAddress(address: string): boolean {
  if (!address) return false;
  
  // Remove 0x prefix if present
  const cleanAddress = address.startsWith('0x') ? address.slice(2) : address;
  
  // Check if it's a valid hex string of correct length
  const hexRegex = /^[0-9a-fA-F]+$/;
  return hexRegex.test(cleanAddress) && (cleanAddress.length === 64 || cleanAddress.length === 40);
}

function normalizeSuiAddress(address: string): string {
  return address.startsWith('0x') ? address : `0x${address}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { recipientAddress, amount, coinType, memo } = req.body;
    const sessionId = req.cookies['session-id'];

    console.log('Transfer API called with:', {
      recipientAddress: recipientAddress ? `${recipientAddress.slice(0, 10)}...` : 'none',
      amount,
      coinType,
      sessionId: sessionId ? 'present' : 'missing',
      hasSession: sessionId ? sessions.has(sessionId) : false
    });

    // Validate session
    let session: SessionData;
    try {
      session = validateSession(sessionId, 'transfer');
    } catch (error) {
      console.error('Session validation failed:', error);
      clearSessionCookie(res);
      return res.status(401).json({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Session validation failed' 
      });
    }

    // Validate inputs
    if (!recipientAddress || !amount || !coinType) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: recipientAddress, amount, coinType'
      });
    }

    if (!isValidSuiAddress(recipientAddress)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid recipient address format'
      });
    }

    const normalizedRecipient = normalizeSuiAddress(recipientAddress);
    const transferAmount = BigInt(amount);

    if (transferAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Amount must be greater than 0'
      });
    }

    // Prevent self-transfer
    if (normalizedRecipient.toLowerCase() === session.account!.userAddr.toLowerCase()) {
      return res.status(400).json({
        success: false,
        error: 'Cannot transfer to your own address'
      });
    }

    // For non-SUI transfers, pre-select coins before building the transaction
    const selectedCoins: { objectId: string; balance: bigint }[] = [];
    
    if (coinType !== '0x2::sui::SUI') {
      const client = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
      
      // Get user's coins for this type
      const coins = await client.getCoins({
        owner: session.account!.userAddr,
        coinType: coinType
      });

      if (coins.data.length === 0) {
        return res.status(400).json({
          success: false,
          error: `No ${coinType} coins found in your wallet`
        });
      }

      // Sort coins by balance (largest first) for efficient selection
      const sortedCoins = coins.data.sort((a, b) => 
        Number(BigInt(b.balance) - BigInt(a.balance))
      );

      let totalSelected = BigInt(0);

      // Select coins to cover the transfer amount
      for (const coin of sortedCoins) {
        if (totalSelected >= transferAmount) break;
        
        const coinBalance = BigInt(coin.balance);
        selectedCoins.push({ objectId: coin.coinObjectId, balance: coinBalance });
        totalSelected += coinBalance;
        
        if (totalSelected >= transferAmount) {
          break;
        }
      }

      if (totalSelected < transferAmount) {
        return res.status(400).json({
          success: false,
          error: `Insufficient balance. Available: ${totalSelected.toString()}, Required: ${transferAmount.toString()}`
        });
      }
    }

    console.log('Executing transfer:', {
      from: session.account!.userAddr,
      to: normalizedRecipient,
      amount: transferAmount.toString(),
      coinType,
      memo
    });

    // Execute the transfer using zkLogin service
    const result = await enokiZkLoginService.sendTransaction(
      session.account!,
      (txb) => {
        if (coinType === '0x2::sui::SUI') {
          // For SUI transfers, split from gas
          const [coin] = txb.splitCoins(txb.gas, [transferAmount]);
          txb.transferObjects([coin], normalizedRecipient);
        } else {
          // For other coin types, use pre-selected coins
          if (selectedCoins.length === 0) {
            throw new Error('No coins selected for transfer');
          }

          if (selectedCoins.length === 1) {
            // Single coin case
            const coinBalance = selectedCoins[0].balance;
            
            if (coinBalance === transferAmount) {
              // Transfer the entire coin
              txb.transferObjects([txb.object(selectedCoins[0].objectId)], normalizedRecipient);
            } else {
              // Split the coin and transfer the exact amount
              const [splitCoin] = txb.splitCoins(
                txb.object(selectedCoins[0].objectId), 
                [transferAmount]
              );
              txb.transferObjects([splitCoin], normalizedRecipient);
            }
          } else {
            // Multiple coins case - merge them first
            const primaryCoin = selectedCoins[0];
            const otherCoins = selectedCoins.slice(1);
            
            // Merge all coins into the primary coin
            if (otherCoins.length > 0) {
              txb.mergeCoins(
                txb.object(primaryCoin.objectId),
                otherCoins.map(coin => txb.object(coin.objectId))
              );
            }
            
            // Calculate total balance
            const totalSelected = selectedCoins.reduce((sum, coin) => sum + coin.balance, BigInt(0));
            
            // Now split the exact amount from the merged coin
            if (totalSelected === transferAmount) {
              // Transfer the entire merged coin
              txb.transferObjects([txb.object(primaryCoin.objectId)], normalizedRecipient);
            } else {
              // Split the exact amount
              const [splitCoin] = txb.splitCoins(
                txb.object(primaryCoin.objectId), 
                [transferAmount]
              );
              txb.transferObjects([splitCoin], normalizedRecipient);
            }
          }
        }

        // Add memo as a custom event if provided
        if (memo) {
          // You could emit a custom event here if your contract supports it
          console.log('Transfer memo:', memo);
        }
      },
      {
        gasBudget: 10000000, // 0.01 SUI
      }
    );

    if (result.status === 'success') {
      console.log('Transfer successful:', result.digest);
      return res.status(200).json({
        success: true,
        digest: result.digest,
        gasUsed: result.gasUsed
      });
    } else {
      console.error('Transfer failed:', result.error);
      return res.status(500).json({
        success: false,
        error: result.error || 'Transfer failed'
      });
    }

  } catch (error) {
    console.error('Transfer API error:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error'
    });
  }
} 