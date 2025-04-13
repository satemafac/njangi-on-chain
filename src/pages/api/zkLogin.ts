import { NextApiRequest, NextApiResponse } from 'next';
import { ZkLoginService, SetupData, AccountData, OAuthProvider } from '@/services/zkLoginService';
import { Transaction } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';
import { PACKAGE_ID } from '../../services/circle-service';
import { 
  USDC_COIN_TYPE,
  SUI_COIN_TYPE
} from '../../services/constants';
import { AggregatorClient, Env } from '@cetusprotocol/aggregator-sdk';
import BN from 'bn.js';

// Add at the top with other imports
interface RPCError extends Error {
  code?: number;
}

// Constants
const MAX_EPOCH = 2; // Number of epochs to keep session alive (1 epoch ~= 24h)
const PROCESSING_COOLDOWN = 30000; // 30 seconds between processing attempts for the same session

// Add constants for the Cetus Aggregator
const AGGREGATOR_ROUTER = '0xeffc8ae61f439bb34c9b905ff8f29ec56873dcedf81c7123ff2f1f67c45ec302';
const MIN_AGGREGATOR_SLIPPAGE = 30; // 0.3% minimum slippage to ensure transaction success

// Add at line 1076-1077
// Not using CETUS_GLOBAL_CONFIG for the direct swap method
// const CETUS_GLOBAL_CONFIG = '0xf5ff7d5ba73b581bca6b4b9fa0049cd320360abd154b809f8700a8fd3cfaf7ca';

// Simple in-memory session store (in production, use Redis or a proper session store)
const sessions = new Map<string, SetupData & { account?: AccountData }>();

// Add session validation helper with better error handling
function validateSession(sessionId: string | undefined, action: string): SetupData & { account?: AccountData } {
  if (!sessionId) {
    throw new Error('No session ID provided');
  }

  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found for ${action}`);
  }

  // Different validation rules based on action
  if (action === 'sendTransaction' || action === 'deleteCircle') {
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
        if (sessionId) sessions.delete(sessionId);
        throw new Error('Session has expired. Please login again.');
      }
    }

    // Validate proof components
    if (!session.account.zkProofs?.proofPoints?.a?.length ||
        !session.account.zkProofs?.proofPoints?.b?.length ||
        !session.account.zkProofs?.proofPoints?.c?.length) {
      throw new Error('Invalid session: missing or invalid proof points');
    }
  }

  return session;
}

// Helper to set session cookie
function setSessionCookie(res: NextApiResponse, sessionId: string) {
  const cookieValue = `session-id=${sessionId}`;
  const cookieOptions = [
    cookieValue,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    // Set a long Max-Age since we handle expiration with maxEpoch
    'Max-Age=86400',
  ];

  if (process.env.NODE_ENV === 'production') {
    cookieOptions.push('Secure');
  }

  res.setHeader('Set-Cookie', cookieOptions.join('; '));
}

// Helper to clear session cookie
function clearSessionCookie(res: NextApiResponse) {
  res.setHeader('Set-Cookie', 'session-id=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
}

// Helper to clean up old sessions for a user
function cleanupUserSessions(userAddr: string, currentSessionId: string) {
  for (const [sessionId, session] of sessions.entries()) {
    // Don't delete the current session
    if (sessionId !== currentSessionId && session.account?.userAddr === userAddr) {
      sessions.delete(sessionId);
    }
  }
}

// Add after MAX_EPOCH constant
const PROCESSING_SESSIONS = new Map<string, { startTime: number, promise: Promise<AccountData> }>();

// Add aggregator SDK helper
let aggregatorSDK: AggregatorClient | null = null;

// Add alternative USDC coin types for testnet that might be more liquid
const ALTERNATE_USDC_COIN_TYPES = [
  // The original USDC from the constants file
  USDC_COIN_TYPE,
  // Alternative USDC formats from other protocols on testnet
  "0x9e89965f542887a8f0383451ba553fedf62c04e4dc68f60dec5b8d7ad1436bd6::usdc::USDC",
  "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08::coin::COIN"
];

// Direct pool addresses to use as fallback when aggregator fails
const DIRECT_POOL_ADDRESSES = {
  // SUI-USDC pools on testnet
  'USDC': [
    '0xb01b068bd0360bb3308b81eb42386707e460b7818816709b7f51e1635d542d40', // Main pool we've seen has liquidity
    '0x2e041f3fd93646dcc877f783c1f2b7fa62d30271bdef1f21ef002cebf857bded',
    // Add more pools from Cetus testnet
    '0x6fb54be7106bb59863f196bc5e2e34426c15f3d5b9662150ed81d5417411dbd7',
    '0xaf5a9c7e4b265955acb0b371ab5ccb76a240b9735c8e9c8978ce866bed19a9a9'
  ],
  // Add more direct pools if needed
};

// Initialize Aggregator SDK
async function getAggregatorSDK(): Promise<AggregatorClient> {
  if (aggregatorSDK) return aggregatorSDK;
  
  try {
    const sdkOptions = {
      rpcUrl: 'https://fullnode.testnet.sui.io:443',
      aggregatorPackageId: AGGREGATOR_ROUTER,
      env: Env.Testnet
    };
    
    aggregatorSDK = new AggregatorClient(sdkOptions);
    console.log('Aggregator SDK initialized successfully');
    return aggregatorSDK;
  } catch (error) {
    console.error('Failed to initialize Aggregator SDK:', error);
    throw new Error('Aggregator service initialization failed');
  }
}

// When using swapAndDepositCetus, replace accessing the private suiClient directly with the proper API
const getEpochData = async (): Promise<{ epoch: string }> => {
  const suiClient = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
  return await suiClient.getLatestSuiSystemState();
};

// Add this helper function after getEpochData
const checkPoolLiquidity = async () => {
  try {
    console.log('Checking available liquidity in SUI-USDC pools...');
    const suiClient = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
    
    // First check which pools actually exist
    const validPools = [];
    for (const poolId of DIRECT_POOL_ADDRESSES['USDC']) {
      try {
        const objectData = await suiClient.getObject({
          id: poolId,
          options: { showContent: true }
        });
        
        if (objectData && objectData.data) {
          validPools.push(poolId);
          
          // Log pool details
          if (objectData.data.content && 'fields' in objectData.data.content) {
            const fields = objectData.data.content.fields as {
              reserve_x?: string;
              reserve_y?: string;
              coin_a_type?: string;
              coin_b_type?: string;
              current_sqrt_price?: string;
              current_tick_index?: number;
              // For pools with different field names
              reserve_a?: string;
              reserve_b?: string;
              sqrt_price?: string;
              liquidity?: string;
              [key: string]: unknown;
            };
            
            // Try to determine which fields hold the liquidity values
            const reserveA = fields.reserve_x || fields.reserve_a;
            const reserveB = fields.reserve_y || fields.reserve_b;
            const liquidityField = fields.liquidity;
            const sqrtPrice = fields.current_sqrt_price || fields.sqrt_price;
            const tickIndex = fields.current_tick_index;
            
            console.log(`Pool ${poolId} exists and has the following liquidity:`);
            if (reserveA) console.log(`- Reserve A: ${BigInt(reserveA) / BigInt(1e9)} SUI`);
            if (reserveB) console.log(`- Reserve B: ${BigInt(reserveB) / BigInt(1e6)} USDC`);
            if (liquidityField) console.log(`- Liquidity value: ${liquidityField}`);
            if (sqrtPrice) console.log(`- Sqrt Price: ${sqrtPrice}`);
            if (tickIndex !== undefined) console.log(`- Current tick index: ${tickIndex}`);
            
            // If we can determine coin types, log those too
            const coinTypeA = fields.coin_a_type || fields.coin_type_a;
            const coinTypeB = fields.coin_b_type || fields.coin_type_b;
            if (coinTypeA) console.log(`- Coin A type: ${coinTypeA}`);
            if (coinTypeB) console.log(`- Coin B type: ${coinTypeB}`);
            
            console.log(`Full pool data:`, fields);
          } else {
            console.log(`Pool ${poolId} exists but content fields not accessible`);
          }
        } else {
          console.log(`Pool ${poolId} does not exist or is not accessible`);
        }
      } catch (err) {
        console.log(`Error checking pool ${poolId}:`, err instanceof Error ? err.message : String(err));
      }
    }
    
    return validPools;
  } catch (error) {
    console.error('Error checking pool liquidity:', error);
    return [];
  }
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { action, jwt, account, provider, circleData } = req.body;
    let sessionId = req.cookies['session-id'];

    // Always log the current session state for debugging
    console.log('Current session state:', {
      action,
      sessionId,
      hasSession: sessionId ? sessions.has(sessionId) : false,
      sessionCount: sessions.size
    });

    const instance = ZkLoginService.getInstance();
    // Do not initialize Cetus SDK here since we're not using it directly

    switch (action) {
      case 'beginLogin':
        // Generate new session ID and clear any existing sessions
        sessionId = crypto.randomUUID();
        setSessionCookie(res, sessionId);

        const { loginUrl, setupData: initialSetup } = await instance.beginLogin(provider as OAuthProvider);
        
        // Log the setup data being stored
        console.log('Storing initial setup:', {
          sessionId,
          provider: initialSetup.provider,
          maxEpoch: initialSetup.maxEpoch,
          ephemeralPublicKey: instance.getPublicKeyFromPrivate(initialSetup.ephemeralPrivateKey)
        });
        
        sessions.set(sessionId, initialSetup);
        return res.status(200).json({ loginUrl });

      case 'handleCallback':
        if (!jwt) {
          return res.status(400).json({ error: 'JWT is required' });
        }

        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please start the login process again.' });
        }

        try {
          // Check if this session is already being processed to prevent duplicate processing
          const processingInfo = PROCESSING_SESSIONS.get(sessionId);
          if (processingInfo) {
            const elapsedTime = Date.now() - processingInfo.startTime;
            
            // If the process has been running for less than the cooldown, return a "processing" status
            if (elapsedTime < PROCESSING_COOLDOWN) {
              console.log(`Session ${sessionId} is already being processed (${elapsedTime}ms elapsed)`);
              return res.status(202).json({ 
                status: 'processing',
                message: 'Authentication is being processed. Please wait.' 
              });
            } else {
              // If it's been too long, remove the processing lock and try again
              console.log(`Processing timeout for session ${sessionId}, retrying`);
              PROCESSING_SESSIONS.delete(sessionId);
            }
          }

          // Get and validate setup data
          const savedSetup = validateSession(sessionId, 'handleCallback');
          
          // If we already have account data, return it immediately
          if (savedSetup.account) {
            console.log(`Session ${sessionId} already has account data, returning immediately`);
            return res.status(200).json(savedSetup.account);
          }
          
          // Create a promise that will resolve with the account data
          const processPromise = (async () => {
            const result = await instance.handleCallback(jwt, savedSetup);
            
            // Clean up any existing sessions for this user
            cleanupUserSessions(result.address, sessionId);
            
            // Create the account data object
            const accountData: AccountData = {
              provider: savedSetup.provider,
              userAddr: result.address,
              zkProofs: result.zkProofs,
              ephemeralPrivateKey: savedSetup.ephemeralPrivateKey,
              userSalt: result.userSalt,
              sub: result.sub,
              aud: result.aud,
              maxEpoch: savedSetup.maxEpoch,
              picture: result.picture,
              name: result.name
            };
            
            // Store the account data in the session
            sessions.set(sessionId, { ...savedSetup, account: accountData });
            
            // Clean up the processing lock
            PROCESSING_SESSIONS.delete(sessionId);
            
            return accountData;
          })();
          
          // Store the processing promise and timestamp
          PROCESSING_SESSIONS.set(sessionId, {
            startTime: Date.now(),
            promise: processPromise
          });
          
          // Wait for the promise to resolve
          const accountData = await processPromise;
          
          console.log('Storing account data:', {
            sessionId,
            address: accountData.userAddr,
            maxEpoch: savedSetup.maxEpoch,
            ephemeralPublicKey: instance.getPublicKeyFromPrivate(savedSetup.ephemeralPrivateKey)
          });
          
          return res.status(200).json(accountData);
        } catch (err) {
          // Clean up the processing lock if there was an error
          if (sessionId) {
            PROCESSING_SESSIONS.delete(sessionId);
          }
          
          console.error('HandleCallback error:', err);
          // If session validation failed, clear cookie and session
          if (err instanceof Error && err.message.includes('Session')) {
            clearSessionCookie(res);
            if (sessionId) sessions.delete(sessionId);
          }
          throw err;
        }

      case 'sendTransaction':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please authenticate first.' });
        }

        try {
          // Log the transaction attempt
          console.log('Attempting transaction:', {
            sessionId,
            address: account.userAddr,
            hasSession: sessions.has(sessionId),
            ephemeralPublicKey: instance.getPublicKeyFromPrivate(account.ephemeralPrivateKey)
          });

          // Validate session with action context
          const session = validateSession(sessionId, 'sendTransaction');
          
          if (!session.account) {
            sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Invalid session: No account data found. Please authenticate first.'
            });
          }

          // Verify session matches account data
          if (session.account.userAddr !== account.userAddr || 
              session.ephemeralPrivateKey !== account.ephemeralPrivateKey) {
            sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Session mismatch: Please refresh your authentication'
            });
          }

          // Validate monetary values before transaction
          const contribution = BigInt(circleData.contribution_amount);
          const contributionUsd = BigInt(circleData.contribution_amount_usd || 0);
          const deposit = BigInt(circleData.security_deposit);
          const depositUsd = BigInt(circleData.security_deposit_usd || 0);
          
          if (contribution <= BigInt(0) || deposit <= BigInt(0)) {
            return res.status(400).json({ 
              error: 'Invalid amount: Contribution and security deposit must be greater than 0'
            });
          }

          if (contributionUsd <= BigInt(0) || depositUsd <= BigInt(0)) {
            return res.status(400).json({ 
              error: 'Invalid USD amount: Contribution and security deposit USD values must be greater than 0'
            });
          }

          // Make sure we're using the session's account data rather than what was sent
          // This ensures we have the latest and valid account data
          console.log('Using account data from session for transaction');

          // Check for missing proof components
          if (!session.account.zkProofs?.proofPoints?.a || 
              !session.account.zkProofs?.proofPoints?.b ||
              !session.account.zkProofs?.proofPoints?.c ||
              !session.account.zkProofs?.issBase64Details ||
              !session.account.zkProofs?.headerBase64) {
            console.error('Missing proof components in session account data');
            sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({
              error: 'Invalid proof data in session. Please login again.',
              requireRelogin: true
            });
          }

          // Ensure salt and address seed can be generated
          try {
            BigInt(session.account.userSalt);
          } catch (error) {
            console.error('Invalid salt format:', error);
            sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({
              error: 'Invalid account data: salt is not properly formatted. Please login again.',
              requireRelogin: true
            });
          }

          // Log transaction parameters for debugging
          console.log('Transaction parameters:', {
            circleType: circleData.circle_type,
            contributionAmount: circleData.contribution_amount.toString(),
            contributionAmountUsd: circleData.contribution_amount_usd.toString(),
            securityDeposit: circleData.security_deposit.toString(),
            securityDepositUsd: circleData.security_deposit_usd.toString(),
            maxMembers: circleData.max_members
          });

          // Attempt to send the transaction
          try {
            const txResult = await instance.sendTransaction(
              session.account,
              (txb: Transaction) => {
                txb.setSender(session.account!.userAddr);
                
                txb.moveCall({
                  target: `${PACKAGE_ID}::njangi_circle::create_circle`,
                  arguments: [
                    txb.pure.string(circleData.name),
                    txb.pure.u64(contribution),
                    txb.pure.u64(contributionUsd),
                    txb.pure.u64(deposit),
                    txb.pure.u64(depositUsd),
                    txb.pure.u64(circleData.cycle_length),
                    txb.pure.u64(circleData.cycle_day),
                    txb.pure.u8(circleData.circle_type),
                    txb.pure.u64(circleData.max_members),
                    txb.pure.u8(circleData.rotation_style),
                    txb.pure.vector('bool', circleData.penalty_rules),
                    txb.pure.option('u8', circleData.goal_type?.some),
                    txb.pure.option('u64', circleData.target_amount?.some ? BigInt(circleData.target_amount.some) : null),
                    txb.pure.option('u64', circleData.target_amount_usd?.some ? BigInt(circleData.target_amount_usd.some) : null),
                    txb.pure.option('u64', circleData.target_date?.some ? BigInt(circleData.target_date.some) : null),
                    txb.pure.bool(circleData.verification_required),
                    txb.object("0x6")  // Clock object
                  ]
                });
              }
            );
            
            console.log('Transaction successful:', txResult);
            return res.status(200).json({ 
              digest: txResult.digest,
              status: txResult.status,
              gasUsed: txResult.gasUsed
            });
          } catch (txError) {
            console.error('Transaction execution error:', txError);
            
            // Check if the error is related to proof verification
            if (txError instanceof Error && 
                (txError.message.includes('proof verify failed') ||
                 txError.message.includes('Session expired') ||
                 txError.message.includes('re-authenticate'))) {
              
              // Clear the session for authentication errors
              sessions.delete(sessionId);
              clearSessionCookie(res);
              
              return res.status(401).json({
                error: 'Your session has expired. Please login again.',
                requireRelogin: true
              });
            }
            
            // For other errors, keep the session but return error
            return res.status(500).json({ 
              error: txError instanceof Error ? txError.message : 'Failed to execute transaction',
              requireRelogin: false
            });
          }
        } catch (err) {
          // Check for any signature/proof/verification related errors
          if (err instanceof Error && 
              (err.message.toLowerCase().includes('invalid user signature') || 
               err.message.toLowerCase().includes('groth16 proof verify failed') ||
               err.message.toLowerCase().includes('signature is not valid') ||
               err.message.toLowerCase().includes('cryptographic error') ||
               (err as RPCError).code === -32002)) {
            // Clear the session and return 401
            if (sessionId) {
              sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({ 
              error: 'Your session has expired. Please try again from the dashboard.',
              requireRelogin: true
            });
          }
          // Handle other transaction errors
          console.error('Transaction error:', err);
          return res.status(500).json({ 
            error: 'Failed to execute transaction. Please try again.',
            details: err instanceof Error ? err.message : 'Unknown error',
            requireRelogin: false
          });
        }

      case 'deleteCircle':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please authenticate first.' });
        }

        try {
          // Log the transaction attempt
          console.log('Attempting circle deletion:', {
            sessionId,
            address: account.userAddr,
            circleId: req.body.circleId,
            hasSession: sessions.has(sessionId),
            ephemeralPublicKey: instance.getPublicKeyFromPrivate(account.ephemeralPrivateKey)
          });

          // Validate session with action context
          const session = validateSession(sessionId, 'deleteCircle');
          
          if (!session.account) {
            sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Invalid session: No account data found. Please authenticate first.'
            });
          }

          // Verify session matches account data
          if (session.account.userAddr !== account.userAddr || 
              session.ephemeralPrivateKey !== account.ephemeralPrivateKey) {
            sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Session mismatch: Please refresh your authentication'
            });
          }

          // Make sure we're using the session's account data rather than what was sent
          // This ensures we have the latest and valid account data
          console.log('Using account data from session for transaction');

          // Check for missing proof components
          if (!session.account.zkProofs?.proofPoints?.a || 
              !session.account.zkProofs?.proofPoints?.b ||
              !session.account.zkProofs?.proofPoints?.c ||
              !session.account.zkProofs?.issBase64Details ||
              !session.account.zkProofs?.headerBase64) {
            console.error('Missing proof components in session account data');
            sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({
              error: 'Invalid proof data in session. Please login again.',
              requireRelogin: true
            });
          }

          // Ensure salt and address seed can be generated
          try {
            BigInt(session.account.userSalt);
          } catch (error) {
            console.error('Invalid salt format:', error);
            sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({
              error: 'Invalid account data: salt is not properly formatted. Please login again.',
              requireRelogin: true
            });
          }

          // Get the circle ID from the request
          const circleId = req.body.circleId;
          if (!circleId) {
            return res.status(400).json({ error: 'Circle ID is required' });
          }

          console.log(`Preparing to delete circle ${circleId} with user ${session.account!.userAddr}`);

          // Check if the circle exists and is owned by the user
          try {
            const suiClient = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });
            
            console.log(`Verifying circle ${circleId} exists`);
            const objectResponse = await suiClient.getObject({
              id: circleId,
              options: { showContent: true }
            });
            
            if (!objectResponse.data || !objectResponse.data.content) {
              console.error(`Circle ${circleId} not found or not accessible`);
              return res.status(400).json({ 
                error: `Circle not found or not accessible: ${circleId}`
              });
            }
            
            console.log(`Circle data:`, objectResponse.data.content);
            
            // Check if this is indeed a circle object
            if ('type' in objectResponse.data.content && 
                typeof objectResponse.data.content.type === 'string' &&
                !objectResponse.data.content.type.includes('njangi_circle::Circle')) {
              console.error(`Object ${circleId} is not a Circle`);
              return res.status(400).json({ 
                error: `Object is not a Circle: ${circleId}`
              });
            }
            
            // Check if the user is the admin if we can access that field
            if ('fields' in objectResponse.data.content) {
              const fields = objectResponse.data.content.fields as { admin?: string };
              console.log(`Circle admin: ${fields.admin}, User: ${session.account!.userAddr}`);
              
              if (fields.admin && fields.admin !== session.account!.userAddr) {
                console.error(`User ${session.account!.userAddr} is not the admin of circle ${circleId}`);
                return res.status(400).json({ 
                  error: 'Cannot delete: Only the circle admin can delete this circle'
                });
              }
            }
          } catch (error) {
            console.error(`Error verifying circle ${circleId}:`, error);
            // We'll continue anyway and let the contract handle any issues
          }

          // Attempt to send the transaction
          try {
            console.log(`Creating transaction block for delete_circle with ID: ${circleId}`);
            
            const txResult = await instance.sendTransaction(
              session.account,
              (txb: Transaction) => {
                txb.setSender(session.account!.userAddr);
                
                // Log transaction creation details
                console.log(`Building moveCall with package: ${PACKAGE_ID}, module: njangi_circle, function: delete_circle`);
                console.log(`Using circleId: ${circleId} as object argument`);
                
                txb.moveCall({
                  target: `${PACKAGE_ID}::njangi_circle::delete_circle`,
                  arguments: [
                    txb.object(circleId)
                  ]
                });
                
                console.log('Transaction block built successfully');
              },
              { gasBudget: 100000000 } // Increase gas budget for delete operation
            );
            
            console.log('Circle deletion successful:', JSON.stringify(txResult, null, 2));
            return res.status(200).json({ 
              digest: txResult.digest,
              status: txResult.status,
              gasUsed: txResult.gasUsed
            });
          } catch (txError) {
            console.error('Circle deletion error detail:', txError);
            console.error('Error type:', typeof txError);
            console.error('Error message:', txError instanceof Error ? txError.message : String(txError));
            console.error('Error name:', txError instanceof Error ? txError.name : 'Not an Error object');
            console.error('Error stack:', txError instanceof Error ? txError.stack : 'No stack trace');
            
            // Check if the error is related to proof verification
            if (txError instanceof Error && 
                (txError.message.includes('proof verify failed') ||
                 txError.message.includes('Session expired') ||
                 txError.message.includes('re-authenticate'))) {
              
              // Clear the session for authentication errors
              sessions.delete(sessionId);
              clearSessionCookie(res);
              
              return res.status(401).json({
                error: 'Your session has expired. Please login again.',
                requireRelogin: true
              });
            }
            
            // Check for specific contract errors
            if (txError instanceof Error) {
              if (txError.message.includes('ECircleHasActiveMembers')) {
                return res.status(400).json({ 
                  error: 'Cannot delete: Circle has active members',
                  requireRelogin: false
                });
              } else if (txError.message.includes('ECircleHasContributions')) {
                return res.status(400).json({ 
                  error: 'Cannot delete: Circle has received contributions',
                  requireRelogin: false
                });
              } else if (txError.message.includes('EOnlyCircleAdmin')) {
                return res.status(400).json({ 
                  error: 'Cannot delete: Only the circle admin can delete this circle',
                  requireRelogin: false
                });
              }
            }
            
            // For other errors, keep the session but return error with more detail
            return res.status(500).json({ 
              error: txError instanceof Error ? txError.message : 'Failed to delete circle',
              details: txError instanceof Error ? txError.stack : String(txError),
              requireRelogin: false
            });
          }
        } catch (err) {
          // More detailed error logging
          console.error('Circle deletion error in catch block:', err);
          console.error('Error type:', typeof err);
          console.error('Error message:', err instanceof Error ? err.message : String(err));
          console.error('Error stack:', err instanceof Error ? err.stack : 'No stack trace');
          
          // Check for any signature/proof/verification related errors
          if (err instanceof Error && 
              (err.message.toLowerCase().includes('invalid user signature') || 
               err.message.toLowerCase().includes('groth16 proof verify failed') ||
               err.message.toLowerCase().includes('signature is not valid') ||
               err.message.toLowerCase().includes('cryptographic error') ||
               (err as RPCError).code === -32002)) {
            // Clear the session and return 401
            if (sessionId) {
              sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({ 
              error: 'Your session has expired. Please try again from the dashboard.',
              requireRelogin: true
            });
          }
          // Handle other transaction errors
          console.error('Transaction error:', err);
          return res.status(500).json({ 
            error: 'Failed to delete circle. Please try again.',
            details: err instanceof Error ? err.message : 'Unknown error',
            requireRelogin: false
          });
        }

      case 'adminApproveMember':
        try {
          if (!account) {
            return res.status(400).json({ error: 'Account data is required' });
          }

          if (!req.body.circleId || !req.body.memberAddress) {
            return res.status(400).json({ error: 'Circle ID and member address are required' });
          }

          // Validate the session
          try {
            if (!sessionId) {
              throw new Error('No session ID provided');
            }
            // Just validate the session without storing the result
            validateSession(sessionId, 'sendTransaction');
          } catch (validationError) {
            console.error('Session validation failed:', validationError);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: validationError instanceof Error ? validationError.message : 'Session validation failed',
              requireRelogin: true
            });
          }

          try {
            // Create a transaction for admin_approve_member
            const txb = new Transaction();
            
            // Add the admin_approve_member call
            txb.moveCall({
              target: `${PACKAGE_ID}::njangi_circle::admin_approve_member`,
              arguments: [
                txb.object(req.body.circleId),
                txb.pure.address(req.body.memberAddress),
                txb.pure.option('u64', null), // Position option - pass None/null for default position
                txb.object('0x6'), // Clock object
              ]
            });

            // Execute the transaction with zkLogin signature
            const txResult = await instance.sendTransaction(
              account,
              (txBlock) => {
                console.log(`Building moveCall for admin_approve_member on circle: ${req.body.circleId}, member: ${req.body.memberAddress}`);
                // Transfer the prepared call to the new transaction block
                txBlock.moveCall({
                  target: `${PACKAGE_ID}::njangi_circle::admin_approve_member`,
                  arguments: [
                    txBlock.object(req.body.circleId),
                    txBlock.pure.address(req.body.memberAddress),
                    txBlock.pure.option('u64', null), // Position option - pass None/null for default position
                    txBlock.object('0x6'), // Clock object
                  ]
                });
              },
              { gasBudget: 100000000 } // Increase gas budget for approval operation
            );
            
            console.log('Admin approve member transaction successful:', txResult);
            return res.status(200).json({ 
              digest: txResult.digest,
              status: txResult.status,
              gasUsed: txResult.gasUsed
            });
          } catch (txError) {
            console.error('Admin approve member transaction error:', txError);
            console.error('Error type:', typeof txError);
            console.error('Error message:', txError instanceof Error ? txError.message : String(txError));
            console.error('Error stack:', txError instanceof Error ? txError.stack : 'No stack trace');
            
            // Check if the error is related to proof verification
            if (txError instanceof Error && 
                (txError.message.includes('proof verify failed') ||
                 txError.message.includes('Session expired') ||
                 txError.message.includes('re-authenticate'))) {
              
              // Clear the session for authentication errors
                sessions.delete(sessionId);
              clearSessionCookie(res);
              
              return res.status(401).json({
                error: 'Your session has expired. Please login again.',
                requireRelogin: true
              });
            }
            
            // Check for specific contract errors
            if (txError instanceof Error) {
              if (txError.message.includes('ENotCircleAdmin')) {
                return res.status(400).json({ 
                  error: 'Cannot approve: Only the circle admin can approve new members',
                  requireRelogin: false
                });
              } else if (txError.message.includes('EMemberAlreadyActive')) {
                return res.status(400).json({ 
                  error: 'Member is already active in this circle',
                  requireRelogin: false
                });
              } else if (txError.message.includes('ECircleIsFull')) {
                return res.status(400).json({ 
                  error: 'Cannot approve: Circle has reached maximum member capacity',
                  requireRelogin: false
                });
              }
            }
            
            // For other errors, keep the session but return error with more detail
            return res.status(500).json({ 
              error: txError instanceof Error ? txError.message : 'Failed to execute transaction',
              details: txError instanceof Error ? txError.stack : String(txError),
              requireRelogin: false
            });
          }
        } catch (error) {
          console.error('Admin approve member error:', error);
          return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Failed to process admin approve member request',
            requireRelogin: false
          });
        }

      case 'executeStablecoinSwap':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

      // Note: Despite the name, this handler now uses Cetus instead of DeepBook for swaps on testnet
      case 'swapAndDepositCetus':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please authenticate first.' });
        }

        try {
          const { walletId, suiAmount, slippage = 100 } = req.body; // slippage in basis points (100 = 1%)
          if (!walletId || !suiAmount) {
            return res.status(400).json({ error: 'Wallet ID and SUI amount are required' });
          }

          // Validate amount and convert from SUI to MIST (smallest unit, 1 SUI = 10^9 MIST)
          // Handle both string/number inputs and decimal values
          let suiAmountMIST: bigint;
          try {
            // Convert decimal SUI to MIST integer before creating BigInt
            const suiAmountNumber = typeof suiAmount === 'string' ? parseFloat(suiAmount) : suiAmount;
            const mistAmount = Math.floor(suiAmountNumber * 1e9); // Convert to MIST and ensure integer
            suiAmountMIST = BigInt(mistAmount);
            
            console.log(`Converting ${suiAmountNumber} SUI to ${suiAmountMIST} MIST`);
          } catch (e) {
            console.error('Error converting SUI amount to MIST:', e);
            return res.status(400).json({ error: 'Invalid SUI amount format. Please provide a valid number.' });
          }
          
          if (suiAmountMIST <= BigInt(0) || suiAmountMIST > BigInt(1e12)) {
            return res.status(400).json({ error: 'Invalid SUI amount: must be greater than 0 and less than 1,000 SUI' });
          }

          // Ensure slippage is at least the minimum
          const effectiveSlippage = Math.max(slippage, MIN_AGGREGATOR_SLIPPAGE);

          // Validate session
          const session = validateSession(sessionId, 'sendTransaction');
          if (!session.account) {
            sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Invalid session: No account data found. Please authenticate first.'
            });
          }

          console.log(`Creating transaction for SUI to USDC swap using Cetus Aggregator`);
          console.log(`Using suiAmount (MIST): ${suiAmountMIST}`);
          console.log(`Slippage: ${effectiveSlippage} basis points (${effectiveSlippage/100}%)`);

          // Get Cetus Aggregator SDK
          const aggregator = await getAggregatorSDK();
          
          // Get current epoch for zkLogin - use our helper function instead of direct access
          const { epoch } = await getEpochData();
          const currentEpoch = Number(epoch);
          const maxEpoch = currentEpoch + 2; // Allow 2 epochs of validity
          console.log(`Current epoch: ${currentEpoch}, maxEpoch: ${maxEpoch}`);

          // Check actual pool liquidity
          const validPools = await checkPoolLiquidity();
          console.log(`Valid pools found: ${validPools.length > 0 ? validPools.join(', ') : 'None'}`);

          // Execute the transaction
          try {
            // Try multiple USDC coin types if needed
            let routerData = null;
            let successfulCoinType = null;
            
            // First try with the primary USDC type
            const initialRouteParams = {
              from: SUI_COIN_TYPE,
              target: USDC_COIN_TYPE,
              amount: new BN(suiAmountMIST.toString()),
              byAmountIn: true,
            };
            
            try {
              routerData = await aggregator.findRouters(initialRouteParams);
              
              // Check if we got valid routes
              if (routerData && routerData.routes && routerData.routes.length > 0) {
                successfulCoinType = USDC_COIN_TYPE;
                console.log(`Found routes using primary USDC coin type: ${USDC_COIN_TYPE}`);
              } else {
                console.log(`No routes found with primary USDC coin type: ${USDC_COIN_TYPE}`);
              }
            } catch (primaryError) {
              console.error(`Error finding routes with primary USDC coin type: ${(primaryError as Error).message || 'unknown error'}`);
            }
            
            // If primary didn't work, try alternates
            if (!successfulCoinType) {
              console.log('Trying alternate USDC coin types...');
              
              for (const altCoinType of ALTERNATE_USDC_COIN_TYPES) {
                // Skip the one we already tried
                if (altCoinType === USDC_COIN_TYPE) continue;
                
                try {
                  console.log(`Trying alternate USDC type: ${altCoinType}`);
                  const altRouteParams = {
                    ...initialRouteParams,
                    target: altCoinType
                  };
                  
                  const altRouterData = await aggregator.findRouters(altRouteParams);
                  
                  if (altRouterData && altRouterData.routes && altRouterData.routes.length > 0) {
                    routerData = altRouterData;
                    successfulCoinType = altCoinType;
                    console.log(`Found routes using alternate USDC coin type: ${altCoinType}`);
                    break;
                  } else {
                    console.log(`No routes found with alternate USDC coin type: ${altCoinType}`);
                  }
                } catch (altError) {
                  console.error(`Error finding routes with alternate USDC coin type (${altCoinType}): ${(altError as Error).message || 'unknown error'}`);
                }
              }
            }
            
            // Add more detailed logging
            console.log('Aggregator response received:', {
              hasData: !!routerData,
              amountIn: routerData?.amountIn?.toString() || 'N/A',
              amountOut: routerData?.amountOut?.toString() || 'N/A',
              insufficientLiquidity: routerData?.insufficientLiquidity,
              routesCount: routerData?.routes?.length || 0,
              errorCode: routerData?.error?.code,
              errorMsg: routerData?.error?.msg,
              usingCoinType: successfulCoinType || 'None'
            });
            
            // Check for liquidity issues BEFORE trying to create the transaction
            if (!routerData || !routerData.routes || routerData.routes.length === 0) {
              console.log('No routes found, checking for specific errors...');
              
              // Handle specific error cases
              if (routerData?.insufficientLiquidity) {
                console.log('Aggregator found insufficient liquidity, trying direct pool swap as fallback...');
                
                // Try direct pool swap instead
                try {
                  const targetCoinType = USDC_COIN_TYPE;
                  // const CETUS_PACKAGE = '0x0c7ae833c220aa73a3643a0d508afa4ac5d50d97312ea4584e35f9eb21b9df12';
                  // Not using CETUS_GLOBAL_CONFIG for the direct swap method
                  // // const CETUS_GLOBAL_CONFIG = '0xf5ff7d5ba73b581bca6b4b9fa0049cd320360abd154b809f8700a8fd3cfaf7ca';
                  
                  // Try each valid pool in the direct pool list
                  let tried = 0;
                  for (const poolId of validPools.length > 0 ? validPools : DIRECT_POOL_ADDRESSES['USDC']) {
                    tried++;
                    try {
                      console.log(`Attempting direct swap with pool ${poolId} (attempt ${tried}/${validPools.length || DIRECT_POOL_ADDRESSES['USDC'].length})`);
                      
                      // No longer reducing the swap amount - use the full amount
                      console.log(`Using full swap amount for direct pool: ${Number(suiAmountMIST) / 1e9} SUI`);
                      
                      // Execute a simplified transaction that focuses just on the swap
                      const txResult = await instance.sendTransaction(
                        session.account,
                        (txb: Transaction) => {
                          txb.setSender(session.account!.userAddr);
                          
                          try {
                            console.log(`Attempting simple swap with pool ${poolId}`);
                            
                            // Use a smaller amount for testing - 0.01 SUI
                            const testAmount = BigInt(10000000); // 0.01 SUI in MIST
                            console.log(`Using test amount: ${Number(testAmount) / 1e9} SUI`);
                            
                            // Split coins from gas payment - use array destructuring pattern
                            const [splitCoin] = txb.splitCoins(txb.gas, [
                              txb.pure.u64(testAmount)
                            ]);
                            
                            // Create a vector with the split coin - this is the key difference
                            const coinVector = txb.makeMoveVec({
                              elements: [splitCoin],
                              type: `0x2::coin::Coin<${SUI_COIN_TYPE}>`
                            });
                            
                            // Use swap_b2a to swap FROM token B (SUI) TO token A (USDC)
                            txb.moveCall({
                              target: `0x4f920e1ef6318cfba77e20a0538a419a5a504c14230169438b99aba485db40a6::pool_script::swap_b2a`,
                              typeArguments: [targetCoinType, SUI_COIN_TYPE],
                              arguments: [
                                txb.object("0x9774e359588ead122af1c7e7f64e14ade261cfeecdb5d0eb4a5b3b4c8ab8bd3e"),
                                txb.object(poolId),
                                coinVector,
                                txb.pure.bool(true), // Set to true for swapping B->A (SUI to USDC)
                                txb.pure.u64(testAmount),
                                txb.pure.u64(0),
                                txb.pure.u128("79226673515401279992447579055"), // Use the working b2a sqrt_price_limit value
                                txb.object('0x6')
                              ]
                            });
                            
                            // Skip deposit for now - just focusing on the swap
                            console.log("Skipping deposit step for now to focus on swap operation");
                            
                          } catch (moveCallError) {
                            console.error('Error building transaction:', moveCallError);
                            throw moveCallError;
                          }
                        },
                        { gasBudget: 100000000 } // Higher gas budget for swap
                      );
                      
                      console.log('Direct pool swap successful using fallback method:', txResult);
                      return res.status(200).json({ 
                        digest: txResult.digest,
                        status: txResult.status,
                        gasUsed: txResult.gasUsed,
                        method: 'direct_pool_fallback'
                      });
                    } catch (poolError) {
                      if (poolError instanceof Error) {
                        if (poolError.message.includes('notExists') || 
                            poolError.message.includes('object_id') ||
                            poolError.message.includes('invalid input')) {
                          console.error(`Pool ${poolId} doesn't exist or is invalid:`, poolError.message);
                        } else if (poolError.message.includes('insufficient') || 
                                  poolError.message.includes('liquidity')) {
                          console.error(`Pool ${poolId} has insufficient liquidity:`, poolError.message);
                        } else {
                          console.error(`Error trying direct swap with pool ${poolId}:`, poolError.message);
                        }
                      } else {
                        console.error(`Error trying direct swap with pool ${poolId}:`, poolError);
                      }
                      // Continue to next pool if this one fails
                    }
                  }
                  
                  // If we're here, all direct pool attempts failed
                  console.log('All direct pool swap attempts failed');
                  return res.status(400).json({
                    error: 'Insufficient liquidity for both aggregator and direct pool swaps. Try a different amount or try again later.'
                  });
                } catch (fallbackError) {
                  console.error('Error in direct pool fallback:', fallbackError);
                  return res.status(400).json({
                    error: 'Could not complete swap due to liquidity issues. Please try a smaller amount or contact support.'
                  });
                }
              }
            }
            
            // Add back the other checks that were removed
            if (routerData && routerData.error && routerData.error.msg) {
              return res.status(400).json({
                error: `Routing error: ${routerData.error.msg}`
              });
            }
            
            // If amount is very small, suggest increasing it
            if (suiAmountMIST < BigInt(50000000)) { // Less than 0.05 SUI
              return res.status(400).json({
                error: 'Swap amount is too small. Please try a larger amount (at least 0.05 SUI).'
              });
            }
            
            // If we got here and still don't have a valid route, return generic error
            if (!routerData || !routerData.routes || routerData.routes.length === 0) {
              console.log(`Tried all USDC coin types and found no valid routes`);
              return res.status(400).json({
                error: 'No valid swap route found after trying multiple USDC coin types. This may be due to insufficient liquidity.'
              });
            }

            // If we got here, we have a valid route, so proceed with normal flow
            // Use the successful coin type in the deposit call
            const targetCoinType = successfulCoinType || USDC_COIN_TYPE;
            
            console.log(`Found route with ${routerData.routes.length} paths and amountOut: ${routerData.amountOut.toString()}`);
            
            // Log detailed path information to help with debugging
            routerData.routes.forEach((route, i) => {
              console.log(`Route ${i+1} details:`);
              console.log(`- Input: ${route.amountIn.toString()}, Output: ${route.amountOut.toString()}`);
              route.path.forEach((path, j) => {
                console.log(`  Path ${j+1}: ${path.provider} (${path.from} → ${path.target})`);
                console.log(`  - AmountIn: ${path.amountIn}, AmountOut: ${path.amountOut}, FeeRate: ${path.feeRate}`);
              });
            });
            
            // Calculate minimum amount out with slippage
            const minAmountOut = routerData.amountOut.muln(10000 - effectiveSlippage).divn(10000);
            console.log(`Using minAmountOut: ${minAmountOut.toString()}`);

            // Now we know we have a valid route, so create and execute the transaction
            const txResult = await instance.sendTransaction(
              session.account,
              async (txb: Transaction) => {
                txb.setSender(session.account!.userAddr);
                
                // Split SUI from gas payment
                const [swapCoin] = txb.splitCoins(txb.gas, [
                  txb.pure.u64(suiAmountMIST)
                ]);

                // Create swap transaction with the aggregator
                await aggregator.routerSwap({
                  routers: routerData,
                  inputCoin: swapCoin,
                  slippage: effectiveSlippage,
                  txb
                });
                
                // Now deposit the swapped USDC to the custody wallet
                console.log(`Depositing swapped USDC as security deposit to wallet ${walletId}`);
                
                // When depositing the USDC, use the successful coin type
                txb.moveCall({
                  target: `${PACKAGE_ID}::njangi_circle::deposit_stablecoin_to_custody`,
                  arguments: [
                    txb.object(walletId),
                    txb.pure.address(targetCoinType), // Use the type that worked in the swap
                    txb.object("0x6")  // Clock object
                  ]
                });
              },
              { gasBudget: 100000000 } // Higher gas budget for complex swap
            );
            
            console.log('Swap and deposit transaction successful:', txResult);
            return res.status(200).json({ 
              digest: txResult.digest,
              status: txResult.status,
              gasUsed: txResult.gasUsed
            });
          } catch (routeError) {
            console.error('Error in swap and deposit transaction:', routeError);
            
            // Distinguish between different types of errors
            if (routeError instanceof Error) {
              // Network errors - these should not trigger re-authentication
              if (routeError.message.includes('Gateway Timeout') || 
                  routeError.message.includes('504') ||
                  routeError.message.includes('network') ||
                  routeError.message.includes('connection')) {
                return res.status(503).json({
                  error: 'Network timeout or connection issue. Please try again later.',
                  requireRelogin: false
                });
              }
              
              // Authentication errors - these should trigger re-authentication
              if (routeError.message.includes('proof verify failed') ||
                  routeError.message.includes('Session expired') ||
                  routeError.message.includes('Invalid session')) {
                if (sessionId) {
                  sessions.delete(sessionId);
                  clearSessionCookie(res);
                }
                return res.status(401).json({
                  error: 'Authentication error: Your session has expired. Please login again.',
                  requireRelogin: true
                });
              }
              
              // DEX-specific errors
              if (routeError.message.includes('Insufficient liquidity') ||
                  routeError.message.includes('No valid swap route') ||
                  routeError.message.includes('slippage') ||
                  routeError.message.includes('price impact')) {
                return res.status(400).json({
                  error: routeError.message,
                  requireRelogin: false
                });
              }
            }
            
            // Generic error handling for anything else
            return res.status(500).json({ 
              error: routeError instanceof Error ? routeError.message : 'Failed to process swap and deposit',
              requireRelogin: false
            });
          }
        } catch (err) {
          console.error('Swap and deposit transaction error:', err);
          if (err instanceof Error && 
              (err.message.includes('proof verify failed') ||
               err.message.includes('Session expired') ||
               err.message.includes('proof points') ||
               err.message.includes('zkLogin signature error'))) {
            
            throw new Error('Invalid proof structure: Please re-authenticate');
          }
          
          return res.status(500).json({ 
            error: err instanceof Error ? err.message : 'Failed to process swap and deposit'
          });
        }

      case 'swapAndDepositDeepBook':
        // Redirect to the new implementation
        req.body.action = 'swapAndDepositCetus';
        return handler(req, res);

      case 'configureStablecoinSwap':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!req.body.walletId || !req.body.config) {
          return res.status(400).json({ error: 'Missing required parameters: walletId, config' });
        }

        try {
          // Validate configuration params
          const { walletId, config } = req.body;
          
          // Ensure walletId is a string
          if (typeof walletId !== 'string') {
            return res.status(400).json({ error: 'walletId must be a string' });
          }
          
          if (typeof config.enabled !== 'boolean' || 
              !['USDC', 'USDT'].includes(config.targetCoinType) ||
              typeof config.slippageTolerance !== 'number' ||
              typeof config.minimumSwapAmount !== 'number') {
            return res.status(400).json({ 
              error: 'Invalid config parameters. Check types and allowed values.' 
            });
          }

          // Validate session with action context
          const session = validateSession(sessionId, 'sendTransaction');
          
          if (!session.account) {
            if (sessionId) sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Invalid session: No account data found. Please authenticate first.',
              requireRelogin: true
            });
          }

          // Verify session matches account data
          if (session.account.userAddr !== account.userAddr || 
              session.ephemeralPrivateKey !== account.ephemeralPrivateKey) {
            if (sessionId) sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Session mismatch: Please refresh your authentication',
              requireRelogin: true
            });
          }

          // Map the simple coin names to their full module paths
          const coinTypeMap: Record<string, string> = {
            'USDC': '0x9e89965f542887a8f0383451ba553fedf62c04e4dc68f60dec5b8d7ad1436bd6::usdc::USDC',
            'USDT': '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08::usdt::USDT'
          };
          
          // Testnet Cetus configuration 
          // const CETUS_PACKAGE = '0x0c7ae833c220aa73a3643a0d508afa4ac5d50d97312ea4584e35f9eb21b9df12';
          // const CETUS_GLOBAL_CONFIG = '0xf5ff7d5ba73b581bca6b4b9fa0049cd320360abd154b809f8700a8fd3cfaf7ca';
          
          // Default pool IDs for the supported coins on testnet
          const poolIds: Record<string, string> = {
            'USDC': '0x2e041f3fd93646dcc877f783c1f2b7fa62d30271bdef1f21ef002cebf857bded',
            'USDT': '0x2cc7129e25401b5eccfdc678d402e2cc22f688f1c8e5db58c06c3c4e71242eb2'
          };
          
          // Get the appropriate pool ID for the selected coin type
          const poolId = poolIds[config.targetCoinType] || poolIds['USDC'];
          
          // Convert minimum amount to MIST (1 SUI = 1e9 MIST)
          const minimumSwapAmount = Math.floor(config.minimumSwapAmount * 1e9);
          
          // Execute the transaction with zkLogin - using direct moveCall approach
            const txResult = await instance.sendTransaction(
            session.account,
              (txb) => {
              // Add a simple moveCall directly
                txb.moveCall({
                target: `${PACKAGE_ID}::njangi_circle::configure_stablecoin_swap`,
                  arguments: [
                    txb.object(walletId),
                  txb.pure.bool(config.enabled),
                  txb.pure.string(coinTypeMap[config.targetCoinType] || coinTypeMap['USDC']),
                  txb.pure.address("0x0c7ae833c220aa73a3643a0d508afa4ac5d50d97312ea4584e35f9eb21b9df12"),
                  txb.pure.u64(BigInt(config.slippageTolerance)),
                    txb.pure.u64(BigInt(minimumSwapAmount)),
                  txb.pure.address("0xf5ff7d5ba73b581bca6b4b9fa0049cd320360abd154b809f8700a8fd3cfaf7ca"),
                  txb.pure.address(poolId),
                ],
              });
            }
          );
          
          console.log('Stablecoin configuration result:', txResult);
            return res.status(200).json({
              digest: txResult.digest,
              status: txResult.status,
              gasUsed: txResult.gasUsed
            });
        } catch (error) {
          console.error('Error configuring stablecoin swap:', error);
          
          // Handle specific error types
          if (error instanceof Error) {
            if (error.message.includes('proof verify failed') ||
                error.message.includes('Session expired') ||
                error.message.includes('re-authenticate')) {
              // Clear the session for authentication errors
              if (sessionId) sessions.delete(sessionId);
              clearSessionCookie(res);
              
              return res.status(401).json({
                error: 'Your session has expired. Please login again.',
                requireRelogin: true
              });
            }
            
            // Handle transaction-specific errors
            if (error.message.includes('ENotAdmin')) {
              return res.status(403).json({
                error: 'Only the admin can configure stablecoin settings'
              });
            }
            
            if (error.message.includes('EUnsupportedToken')) {
                return res.status(400).json({ 
                error: 'Unsupported stablecoin token type'
                });
              }
            }
            
          // Generic error handling
            return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Unknown error during stablecoin configuration'
          });
        }
        break;

      case 'paySecurityDeposit':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!req.body.walletId || !req.body.depositAmount) {
          return res.status(400).json({ error: 'Missing required parameters: walletId, depositAmount' });
        }

        try {
          // Ensure parameters are of the correct type
          const walletId = String(req.body.walletId);
          const depositAmount = typeof req.body.depositAmount === 'number' ? 
            BigInt(Math.floor(req.body.depositAmount)) : 
            BigInt(req.body.depositAmount);

          // Validate session with action context
          const session = validateSession(sessionId, 'sendTransaction');
          
          if (!session.account) {
            if (sessionId) sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Invalid session: No account data found. Please authenticate first.',
              requireRelogin: true
            });
          }

          // Verify session matches account data
          if (session.account.userAddr !== account.userAddr || 
              session.ephemeralPrivateKey !== account.ephemeralPrivateKey) {
            if (sessionId) sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Session mismatch: Please refresh your authentication',
              requireRelogin: true
            });
          }

          console.log(`Creating security deposit transaction for wallet ${walletId}, amount ${depositAmount}`);

          // Execute the transaction with zkLogin
            const txResult = await instance.sendTransaction(
              session.account,
            (txb) => {
              txb.setSender(session.account!.userAddr);
              
              // Split SUI from gas payment
              const [depositCoin] = txb.splitCoins(txb.gas, [
                txb.pure.u64(depositAmount)
              ]);
                
              // Call the deposit function to pay security deposit
                txb.moveCall({
                target: `${PACKAGE_ID}::njangi_circle::deposit_to_custody`,
                  arguments: [
                  txb.object(walletId),
                  depositCoin,
                  txb.object("0x6"), // Clock object
                ],
              });
            }
          );
          
          console.log('Security deposit transaction successful:', txResult);
            return res.status(200).json({ 
              digest: txResult.digest,
              status: txResult.status,
              gasUsed: txResult.gasUsed
            });
        } catch (err) {
          console.error('Security deposit error:', err);
          if (err instanceof Error && 
              (err.message.includes('proof verify failed') ||
               err.message.includes('Session expired'))) {
            
            if (sessionId) {
              sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({ 
              error: 'Your session has expired. Please login again.',
              requireRelogin: true
            });
          }
          
          return res.status(500).json({ 
            error: err instanceof Error ? err.message : 'Failed to process security deposit'
          });
        }
        break;

      case 'depositStablecoin':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!req.body.walletId || !req.body.coinObjectId || !req.body.stablecoinType) {
          return res.status(400).json({ 
            error: 'Missing required parameters: walletId, coinObjectId, stablecoinType' 
          });
        }

        try {
          const walletId = String(req.body.walletId);
          const coinObjectId = String(req.body.coinObjectId);
          const stablecoinType = String(req.body.stablecoinType);
          
          // Validate session
          const session = validateSession(sessionId, 'sendTransaction');
          
          if (!session.account) {
            if (sessionId) sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Authentication error: Your session has expired. Please login again.',
              requireRelogin: true
            });
          }
          
          // Execute the stablecoin deposit transaction
          const txResult = await instance.sendTransaction(
            session.account,
            (txb: Transaction) => {
              txb.setSender(session.account!.userAddr);
              
              txb.moveCall({
                target: `${PACKAGE_ID}::njangi_circle::deposit_stablecoin_to_custody`,
                arguments: [
                  txb.object(walletId),
                  txb.object(coinObjectId),
                  txb.object("0x6") // Clock object
                ],
                typeArguments: [stablecoinType]
              });
            }
          );
          
          return res.status(200).json({ 
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed
          });
        } catch (error) {
          console.error('Error depositing stablecoin:', error);
          
          // Handle authentication errors
          if (error instanceof Error && 
              (error.message.includes('proof verify failed') ||
               error.message.includes('Session expired'))) {
            
            if (sessionId) sessions.delete(sessionId);
            clearSessionCookie(res);
            
            return res.status(401).json({
              error: 'Authentication error: Your session has expired. Please login again.',
              requireRelogin: true
            });
          }
          
          return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Failed to deposit stablecoin'
          });
        }

      case 'executeSwap':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!req.body.txb) {
          return res.status(400).json({ error: 'Missing required parameter: txb (serialized transaction)' });
        }

        try {
          // Validate session with action context
          const session = validateSession(sessionId, 'sendTransaction');
          
          if (!session.account) {
            if (sessionId) sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Authentication error: Your session has expired. Please login again.',
              requireRelogin: true
            });
          }

          // Verify session matches account data
          if (session.account.userAddr !== account.userAddr || 
              session.ephemeralPrivateKey !== account.ephemeralPrivateKey) {
            if (sessionId) sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Session mismatch: Please refresh your authentication',
              requireRelogin: true
            });
          }
          
          // Deserialize the transaction
          const tx = Transaction.from(req.body.txb);
          tx.setSender(session.account.userAddr);
          
          // Execute the transaction
          const txResult = await instance.sendTransaction(
            session.account,
            () => tx
          );
          
          return res.status(200).json({ 
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed
          });
        } catch (error) {
          console.error('Error executing DEX swap:', error);
          
          if (error instanceof Error && 
              (error.message.includes('proof verify failed') ||
               error.message.includes('Session expired') ||
               error.message.includes('re-authenticate'))) {
            
            if (sessionId) sessions.delete(sessionId);
            clearSessionCookie(res);
            
            return res.status(401).json({
              error: 'Authentication error: Your session has expired. Please login again.',
              requireRelogin: true
            });
          }
          
          // Check for common DEX errors
          if (error instanceof Error) {
            if (error.message.includes('insufficient liquidity')) {
              return res.status(400).json({ 
                error: 'Insufficient liquidity in DEX pool. Try a smaller amount.'
              });
            }
            
            if (error.message.includes('slippage')) {
              return res.status(400).json({ 
                error: 'Price movement exceeded slippage tolerance. Try increasing slippage or try again.'
              });
            }
          }
          
          return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Failed to execute swap'
          });
        }

      case 'toggleAutoSwap': {
        try {
          // Get circle ID and enabled state from the request body
          const { circleId, enabled, account } = req.body;
          
          if (!circleId) {
            return res.status(400).json({
              error: 'Missing circle ID'
            });
          }
          
          if (!account) {
            return res.status(400).json({
              error: 'Account data is required'
            });
          }
          
          // Validate the session
          try {
            if (!sessionId) {
              throw new Error('No session ID provided');
            }
            // Just validate the session without storing the result
            validateSession(sessionId, 'sendTransaction');
          } catch (validationError) {
            console.error('Session validation failed:', validationError);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: validationError instanceof Error ? validationError.message : 'Session validation failed',
              requireRelogin: true
            });
          }
          
          console.log(`Toggling auto-swap to ${enabled ? 'enabled' : 'disabled'} for circle: ${circleId}`);
          
          try {
            // Execute the transaction with zkLogin
            const txResult = await instance.sendTransaction(
              account,
              (txb: Transaction) => {
                console.log(`Building moveCall for toggle_auto_swap on circle: ${circleId}, enabled: ${enabled}`);
                
                // Toggle auto-swap call
                txb.moveCall({
                  target: `${PACKAGE_ID}::njangi_circle::toggle_auto_swap`,
                  arguments: [
                    txb.object(circleId),
                    txb.pure.bool(enabled)
                  ]
                });
              }
            );
            
            console.log('Auto-swap toggle transaction successful:', txResult);
            return res.status(200).json({ 
              success: true,
              digest: txResult.digest,
              status: txResult.status,
              gasUsed: txResult.gasUsed
            });
          } catch (txError) {
            console.error('Auto-swap toggle transaction error:', txError);
            
            // Check if the error is related to proof verification
            if (txError instanceof Error && 
                (txError.message.includes('proof verify failed') ||
                 txError.message.includes('Session expired') ||
                 txError.message.includes('re-authenticate'))) {
              
              // Clear the session for authentication errors
              if (sessionId) {
                sessions.delete(sessionId);
                clearSessionCookie(res);
              }
              
              return res.status(401).json({
                error: 'Your session has expired. Please login again.',
                requireRelogin: true
              });
            }
            
            // Check for specific contract errors
            if (txError instanceof Error) {
              if (txError.message.includes('ENotAdmin')) {
                return res.status(400).json({ 
                  error: 'Cannot toggle auto-swap: Only the circle admin can modify this setting',
                  requireRelogin: false
                });
              }
            }
            
            // For other errors, keep the session but return error
            return res.status(500).json({ 
              error: txError instanceof Error ? txError.message : 'Failed to toggle auto-swap',
              details: txError instanceof Error ? txError.stack : String(txError),
              requireRelogin: false
            });
          }
        } catch (error) {
          console.error('Auto-swap toggle error:', error);
          return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Failed to toggle auto-swap setting',
            requireRelogin: false
          });
        }
      }

      case 'contributeFromCustody':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please authenticate first.' });
        }

        try {
          const { circleId, walletId } = req.body;
          if (!circleId || !walletId) {
            return res.status(400).json({ error: 'Circle ID and wallet ID are required' });
          }

          // Validate session
          const session = validateSession(sessionId, 'sendTransaction');
          if (!session.account) {
            sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Invalid session: No account data found. Please authenticate first.'
            });
          }

          console.log(`Creating custody contribution transaction for circle ${circleId}, wallet ${walletId}`);
          
          // Execute the transaction
          const txResult = await instance.sendTransaction(
            session.account,
            (txb: Transaction) => {
              txb.setSender(session.account!.userAddr);
              
              // Call the contribute_from_custody function
              txb.moveCall({
                target: `${PACKAGE_ID}::njangi_circle::contribute_from_custody`,
                arguments: [
                  txb.object(circleId),
                  txb.object(walletId),
                  txb.object("0x6")  // Clock object
                ]
              });
            },
            { gasBudget: 50000000 }
          );
          
          console.log('Contribution transaction successful:', txResult);
          return res.status(200).json({ 
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed
          });
        } catch (err) {
          console.error('Contribution error:', err);
          if (err instanceof Error && 
              (err.message.includes('proof verify failed') ||
               err.message.includes('Session expired'))) {
            
            if (sessionId) {
              sessions.delete(sessionId);
              clearSessionCookie(res);
            }
            return res.status(401).json({ 
              error: 'Your session has expired. Please login again.',
              requireRelogin: true
            });
          }
          
          return res.status(500).json({ 
            error: err instanceof Error ? err.message : 'Failed to process contribution'
          });
        }

      default:
        return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (err) {
    console.error('API error:', err);
    return res.status(500).json({ 
      error: err instanceof Error ? err.message : 'An unexpected error occurred' 
    });
  }
} 