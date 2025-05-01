import { NextApiRequest, NextApiResponse } from 'next';
import { ZkLoginService, SetupData, AccountData, OAuthProvider } from '@/services/zkLoginService';
import { ZkLoginError } from '@/services/zkLoginClient';
import { SuiClient } from '@mysten/sui/client';
import { PACKAGE_ID } from '../../services/circle-service';
import { 
  USDC_COIN_TYPE,
  SUI_COIN_TYPE
} from '../../services/constants';
import { AggregatorClient, Env } from '@cetusprotocol/aggregator-sdk';
import BN from 'bn.js';
import { Transaction } from '@mysten/sui/transactions';

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

// Function to get the JSON RPC URL
function getJsonRpcUrl(): string {
  return process.env.SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443';
}

// When using swapAndDepositCetus, replace accessing the private suiClient directly with the proper API
const getEpochData = async (): Promise<{ epoch: string }> => {
  const suiClient = new SuiClient({ url: getJsonRpcUrl() });
  return await suiClient.getLatestSuiSystemState();
};

// Add this helper function after getEpochData
const checkPoolLiquidity = async () => {
  try {
    console.log('Checking available liquidity in SUI-USDC pools...');
    const suiClient = new SuiClient({ url: getJsonRpcUrl() });
    
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

// Add a utility function for formatting micro units (for USDC with 6 decimals)
function formatMicroUnits(amount: bigint): string {
  return (Number(amount) / 1_000_000).toFixed(6);
}

const CLOCK_OBJECT_ID = "0x6"; // Sui system clock object ID

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
          
          // Debug logging to understand value conversions
          console.log("Circle Creation - Monetary Values:", {
            contributionAmountSUI: Number(contribution) / 1e9,  // Convert MIST to SUI
            contributionAmountMIST: contribution.toString(),
            contributionUsdCents: contributionUsd.toString(),
            contributionUsdDollars: Number(contributionUsd) / 100,
            securityDepositSUI: Number(deposit) / 1e9,  // Convert MIST to SUI
            securityDepositMIST: deposit.toString(),
            securityDepositUsdCents: depositUsd.toString(),
            securityDepositUsdDollars: Number(depositUsd) / 100,
            expectedFormat: "The contract expects SUI values in MIST format (9 decimals)"
          });
          
          // Basic validation for reasonable SUI amounts
          const estSuiPrice = Number(contributionUsd) / 100 / (Number(contribution) / 1e9);
          console.log(`Estimated SUI price from values: $${estSuiPrice.toFixed(4)} USD`);
          
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
                  target: `${PACKAGE_ID}::njangi_circles::create_circle`,
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
            const suiClient = new SuiClient({ url: getJsonRpcUrl() });
            
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
                !objectResponse.data.content.type.includes('njangi_circles::Circle')) {
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
                  target: `${PACKAGE_ID}::njangi_circles::delete_circle`,
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
            console.log(`Building moveCall for adding member: ${req.body.circleId}, member: ${req.body.memberAddress}`);
            
            try {
              // Send transaction using zkLogin service
              const txResult = await instance.sendTransaction(
                account,
                (txb: Transaction) => {
                  txb.setSender(account.userAddr);
                  
                  // Call our implemented admin_approve_member function
                  txb.moveCall({
                    target: `${PACKAGE_ID}::njangi_circles::admin_approve_member`,
                    arguments: [
                      txb.object(req.body.circleId),
                      txb.pure.address(req.body.memberAddress),
                      txb.object("0x6")  // Clock object
                    ]
                  });
                },
                { gasBudget: 100000000 } // Higher gas budget for member approval
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
        } catch (error) {
          console.error('Admin approve member error:', error);
          return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Failed to process admin approve member request',
            requireRelogin: false
          });
        }

      case 'adminApproveMembers':
        try {
          if (!account) {
            return res.status(400).json({ error: 'Account data is required' });
          }

          if (!req.body.circleId || !req.body.memberAddresses || !Array.isArray(req.body.memberAddresses)) {
            return res.status(400).json({ error: 'Circle ID and member addresses array are required' });
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
            // Create a transaction for admin_approve_members
            console.log(`Building moveCall for adding multiple members to circle: ${req.body.circleId}, member count: ${req.body.memberAddresses.length}`);
            
            try {
              // Normalize all addresses
              const normalizedAddresses = req.body.memberAddresses.map((addr: string) => {
                // Ensure all addresses have 0x prefix and are lowercase
                return addr.toLowerCase().startsWith('0x') ? addr.toLowerCase() : `0x${addr.toLowerCase()}`;
              });

              // Send transaction using zkLogin service
              const txResult = await instance.sendTransaction(
                account,
                (txb: Transaction) => {
                  txb.setSender(account.userAddr);
                  
                  // Create a move vector of addresses
                  const addressArgs = normalizedAddresses.map((addr: string) => txb.pure.address(addr));
                  
                  // Call our implemented admin_approve_members function
                  txb.moveCall({
                    target: `${PACKAGE_ID}::njangi_circles::admin_approve_members`,
                    arguments: [
                      txb.object(req.body.circleId),
                      txb.makeMoveVec({ elements: addressArgs, type: 'address' }),
                      txb.object("0x6")  // Clock object
                    ]
                  });
                },
                { gasBudget: 150000000 } // Higher gas budget for multiple member approvals
              );
              
              console.log('Admin approve multiple members transaction successful:', txResult);
              return res.status(200).json({
                digest: txResult.digest,
                status: txResult.status,
                gasUsed: txResult.gasUsed
              });
            } catch (txError) {
              console.error('Admin approve multiple members transaction error:', txError);
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
                    error: 'One or more members are already active in this circle',
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
            console.error('Admin approve multiple members error:', error);
            return res.status(500).json({ 
              error: error instanceof Error ? error.message : 'Failed to process bulk member approval request',
              requireRelogin: false
            });
          }
        } catch (error) {
          console.error('Admin approve multiple members error:', error);
          return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Failed to process bulk member approval request',
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
          // Add circleId to the required parameters
          const { walletId, suiAmount, slippage = 100, circleId } = req.body; 
          if (!walletId || !suiAmount || !circleId) {
            return res.status(400).json({ error: 'Wallet ID, Circle ID, and SUI amount are required' });
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
                            
                            // Use the full amount requested by the user
                            console.log(`Using full amount for swap: ${Number(suiAmountMIST) / 1e9} SUI`);
                            
                            // Split coins from gas payment - use array destructuring pattern
                            const [splitCoin] = txb.splitCoins(txb.gas, [
                              txb.pure.u64(suiAmountMIST)
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
                                txb.pure.u64(suiAmountMIST),
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
                // THIS RETURNS THE RESULTING STABLECOIN OBJECT
                const stableCoinResult = await aggregator.routerSwap({
                  routers: routerData,
                  inputCoin: swapCoin,
                  slippage: effectiveSlippage,
                  txb
                });
                
                // Now deposit the swapped USDC to the custody wallet
                console.log(`Depositing swapped ${targetCoinType} as security deposit to circle ${circleId}, wallet ${walletId}`);
                
                // Call the new deposit_security_deposit function with the resulting coin
                txb.moveCall({
                  target: `${PACKAGE_ID}::njangi_circles::member_deposit_security_deposit`,
                  arguments: [
                    txb.object(circleId), // Pass circleId first
                    txb.object(walletId),
                    stableCoinResult,     // Use the coin returned from the swap
                    txb.object("0x6")  // Clock object
                  ],
                  typeArguments: [targetCoinType] // Use the coin type determined during routing
                });
              },
              { gasBudget: 100000000 } // Higher gas budget for complex swap + deposit
            );
            
            console.log('Swap and security deposit transaction successful:', txResult);
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
                target: `${PACKAGE_ID}::njangi_circles::configure_stablecoin_swap`,
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

        // Add circleId to the required parameters
        if (!req.body.walletId || !req.body.depositAmount || !req.body.circleId) {
          return res.status(400).json({ error: 'Missing required parameters: walletId, depositAmount, circleId' });
        }

        try {
          // Ensure parameters are of the correct type
          const circleId = String(req.body.circleId); // Get circleId
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

          console.log(`Creating SUI security deposit transaction for circle ${circleId}, wallet ${walletId}, amount ${depositAmount}`);

          // Execute the transaction with zkLogin
            const txResult = await instance.sendTransaction(
              session.account,
            (txb) => {
              txb.setSender(session.account!.userAddr);
              
              // Split SUI from gas payment
              const [depositCoin] = txb.splitCoins(txb.gas, [
                txb.pure.u64(depositAmount)
              ]);
                
              // Call the NEW entry function in njangi_circles with the resulting coin
                txb.moveCall({
                target: `${PACKAGE_ID}::njangi_circles::member_deposit_security_deposit`,
                arguments: [
                  txb.object(circleId), // Pass circleId first
                  txb.object(walletId),
                  depositCoin,
                  txb.object("0x6"), // Clock object
                ],
                typeArguments: [SUI_COIN_TYPE] // Specify SUI type argument
              });
            },
            { gasBudget: 100000000 } // Keep increased gas budget
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
          
          // Add checks for new error codes from the contract
          if (err instanceof Error) {
            if (err.message.includes('EMemberNotFound')) {
              return res.status(400).json({ error: 'Member not found in this circle.' });
            }
            if (err.message.includes('EMemberNotActive')) {
              return res.status(400).json({ error: 'Member is not active in this circle.' });
            }
            if (err.message.includes('EDepositAlreadyPaid')) {
              return res.status(400).json({ error: 'Security deposit has already been paid.' });
            }
            if (err.message.includes('EIncorrectDepositAmount')) {
              return res.status(400).json({ error: 'Incorrect security deposit amount provided.' });
            }
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

        // Add circleId to required parameters
        if (!req.body.walletId || !req.body.coinObjectId || !req.body.stablecoinType || !req.body.circleId) {
          return res.status(400).json({ 
            error: 'Missing required parameters: circleId, walletId, coinObjectId, stablecoinType' 
          });
        }

        try {
          const circleId = String(req.body.circleId); // Get circleId
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
          
          // Step 1: Get the required security deposit amount from the circle
          const suiClient = new SuiClient({ url: getJsonRpcUrl() });
          let requiredDepositAmount = 0;
          let coinValue = 0;
          
          try {
            // Get the coin object to check available balance
            const coinObject = await suiClient.getObject({
              id: coinObjectId,
              options: { showContent: true }
            });
            
            if (coinObject.data?.content && 'fields' in coinObject.data.content) {
              const coinFields = coinObject.data.content.fields as Record<string, unknown>;
              coinValue = Number(coinFields.balance || 0);
            }
            
            // For USDC security deposit, we need to get it from the dynamic fields
            if (stablecoinType.toLowerCase().includes('usdc')) {
              // First, get the dynamic fields of the circle to find the config
              const dynamicFields = await suiClient.getDynamicFields({
                parentId: circleId
              });
              
              console.log('Searching for CircleConfig in dynamic fields...');
              
              // Find the CircleConfig field
              let configFieldObjectId: string | null = null;
              for (const field of dynamicFields.data) {
                if (field.name && 
                    typeof field.name === 'object' && 
                    'type' in field.name && 
                    field.name.type && 
                    field.name.type.includes('vector<u8>') && 
                    field.objectType && 
                    field.objectType.includes('CircleConfig')) {
                  
                  configFieldObjectId = field.objectId;
                  console.log(`Found CircleConfig dynamic field: ${configFieldObjectId}`);
                  break;
                }
              }
              
              // Get the CircleConfig object if found
              if (configFieldObjectId) {
                const configObject = await suiClient.getObject({
                  id: configFieldObjectId,
                  options: { showContent: true }
                });
                
                console.log('CircleConfig field content:', configObject);
                
                if (configObject.data?.content && 
                    'fields' in configObject.data.content &&
                    'value' in configObject.data.content.fields) {
                  
                  const valueField = configObject.data.content.fields.value;
                  if (typeof valueField === 'object' && 
                      valueField !== null && 
                      'fields' in valueField) {
                    
                    // Extract the security_deposit_usd field
                    const configFields = valueField.fields as Record<string, unknown>;
                    const securityDepositUsd = Number(configFields.security_deposit_usd || 0);
                    
                    console.log('Found security_deposit_usd in CircleConfig:', securityDepositUsd);
                    
                    // The security_deposit_usd is in CENTS (e.g., 20 = $0.20)
                    // But USDC coins are in microUSDC (e.g., 1 USDC = 1,000,000 microUSDC)
                    // So we need to convert cents to microUSDC: 
                    // 1 cent = $0.01 = 10,000 microUSDC
                    if (securityDepositUsd > 0) {
                      requiredDepositAmount = Math.floor(securityDepositUsd * 10000); // cents to microUSDC
                      console.log('Calculated requiredDepositAmount (in microUSDC):', requiredDepositAmount);
                    }
                  }
                }
              }
            } else {
              // For other coins, try to get the regular security_deposit field from circle
              const circleObject = await suiClient.getObject({
                id: circleId,
                options: { showContent: true }
              });
              
              if (circleObject.data?.content && 'fields' in circleObject.data.content) {
                const circleFields = circleObject.data.content.fields as Record<string, unknown>;
                requiredDepositAmount = Number(circleFields.security_deposit || 0);
              }
            }
            
            console.log('Security deposit info:', {
              requiredDepositAmount,
              coinValue,
              coinType: stablecoinType
            });
          } catch (e) {
            console.error('Error checking circle and coin info:', e);
          }
          
          // Execute the transaction with coin splitting if needed
          const txResult = await instance.sendTransaction(
            session.account,
            (txb: Transaction) => {
              txb.setSender(session.account!.userAddr);
              
              if (requiredDepositAmount > 0 && coinValue > requiredDepositAmount) {
                // Create a SplitCoins transaction for exact amount if needed
                console.log(`Splitting coin ${coinObjectId} to get exact required amount: ${requiredDepositAmount} microUSDC`);
                
                // Split the coin to get the exact required amount
                const [depositCoin] = txb.splitCoins(
                  txb.object(coinObjectId), 
                  [txb.pure.u64(BigInt(requiredDepositAmount))]
                );
                
                // Execute the deposit with the split coin
                txb.moveCall({
                  target: `${PACKAGE_ID}::njangi_circles::member_deposit_security_deposit`,
                  typeArguments: [stablecoinType],
                  arguments: [
                    txb.object(circleId),
                    txb.object(walletId),
                    depositCoin, // Use the split coin with the exact amount
                    txb.object(CLOCK_OBJECT_ID)
                  ]
                });
              } else {
                // Just use the coin directly if it matches the required amount
                // or if we couldn't determine the required amount
                txb.moveCall({
                  target: `${PACKAGE_ID}::njangi_circles::member_deposit_security_deposit`,
                  typeArguments: [stablecoinType],
                  arguments: [
                    txb.object(circleId),
                    txb.object(walletId),
                    txb.object(coinObjectId),
                    txb.object(CLOCK_OBJECT_ID)
                  ]
                });
              }
            },
            { gasBudget: 150000000 } // Increase gas budget
          );
          
          console.log('Security deposit transaction successful:', txResult);
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

          // Add checks for new error codes from the contract
          if (error instanceof Error) {
            if (error.message.includes('EMemberNotFound') || error.message.includes('ENotCircleMember') || error.message.includes(', 8)')) {
              return res.status(400).json({ 
                error: 'You are not a member of this circle. Please join the circle first.' 
              });
            }
            
            // More detailed handling for EMemberNotActive error (code 14)
            if (error.message.includes('EMemberNotActive') || error.message.includes(', 14)') || 
                error.message.match(/MoveAbort\(.+, 14\)/)) {
              return res.status(400).json({ 
                error: 'Your membership is not active in this circle. Please contact the circle admin to activate your membership before making a deposit.' 
              });
            }
            
            if (error.message.includes('EDepositAlreadyPaid') || error.message.includes(', 21)')) {
              return res.status(400).json({ 
                error: 'You have already paid the security deposit for this circle.' 
              });
            }
            
            if (error.message.includes('EIncorrectDepositAmount') || error.message.includes(', 2)')) {
              // Since requiredDepositAmount may not be in this scope, provide a generic message
              return res.status(400).json({ 
                error: 'The deposit amount does not match the required security deposit for this circle. For USDC deposits, this should be the exact USD value in micro-units (20 cents = 200,000 microUSDC).' 
              });
            }
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
                  target: `${PACKAGE_ID}::njangi_circles::toggle_auto_swap`,
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
                target: `${PACKAGE_ID}::njangi_circles::contribute_from_custody`,
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

      case 'executeSwapOnly':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        try {
          const { suiAmount, minAmountOut, slippage = 0.5 } = req.body;
          if (!suiAmount) {
            return res.status(400).json({ error: 'SUI amount is required' });
          }

          if (!sessionId) {
            return res.status(401).json({ error: 'No session found. Please authenticate first.' });
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

          console.log(`Creating SUI to USDC swap-only transaction for amount: ${suiAmount}`);
          
          // Use the full amount for the swap
          const suiAmountMIST = typeof suiAmount === 'string' ? 
            BigInt(Math.floor(parseFloat(suiAmount) * 1e9)) : 
            BigInt(Math.floor(suiAmount * 1e9));
            
          console.log(`Using amount for swap: ${Number(suiAmountMIST) / 1e9} SUI`);
          
          // Dynamic slippage approach based on amount size
          // Use more careful slippage for larger amounts, more flexible for smaller amounts
          const effectiveSlippage = Number(slippage);
          const amountInSUI = Number(suiAmountMIST) / 1e9;
          let adaptiveBuffer = 0.05; // Default 5% buffer
          
          // For very small transactions (< 0.1 SUI), allow more buffer to ensure success
          if (amountInSUI < 0.1) {
            adaptiveBuffer = 0.10; // 10% buffer for tiny amounts
          } 
          // For medium transactions around 0.16-0.2 SUI (common security deposit range), be most aggressive
          else if (amountInSUI >= 0.15 && amountInSUI <= 0.2) {
            adaptiveBuffer = 0.25; // 25% buffer for this problematic range
            console.log(`Using extra aggressive buffer (25%) for problematic amount range around 0.16 SUI`);
          }
          // For large transactions (> 1 SUI), be more conservative
          else if (amountInSUI > 1) {
            adaptiveBuffer = 0.03; // 3% buffer for large amounts
          }
          
          // Calculate minAmountOut with adaptive buffer
          // Base calculation on expected rate of ~2.5 USDC per SUI
          const expectedRate = 2.5; // USDC per SUI (approximate market rate)
          const expectedOutput = amountInSUI * expectedRate;
          const calculatedMinAmountOut = Math.floor(expectedOutput * 1e6 * (1 - effectiveSlippage/100));
          
          // Apply adaptive buffer to ensure transaction success
          const effectiveMinAmountOut = minAmountOut ? 
            Math.floor(Number(minAmountOut) * (1 - adaptiveBuffer)) : 
            Math.floor(calculatedMinAmountOut * (1 - adaptiveBuffer));
          
          // Log detailed price information
          console.log(`Expected price: ~${expectedRate} USDC per SUI`);
          console.log(`Expected output: ~${expectedOutput.toFixed(6)} USDC`);
          console.log(`User slippage setting: ${effectiveSlippage}%`);
          console.log(`Adaptive buffer: ${(adaptiveBuffer * 100).toFixed(1)}% based on amount size`);
          console.log(`Min acceptable output: ${(effectiveMinAmountOut/1e6).toFixed(6)} USDC (${((1-(effectiveMinAmountOut/1e6)/expectedOutput)*100).toFixed(2)}% max total slippage)`);

          // Execute only the swap transaction
          const txResult = await instance.sendTransaction(
            session.account,
            (txb: Transaction) => {
              txb.setSender(session.account!.userAddr);
              
              try {
                console.log(`Attempting swap with amount: ${Number(suiAmountMIST) / 1e9} SUI`);
                
                // Split coins from gas payment - use array destructuring pattern
                const [splitCoin] = txb.splitCoins(txb.gas, [
                  txb.pure.u64(suiAmountMIST)
                ]);
                
                // Create a vector with the split coin
                const coinVector = txb.makeMoveVec({
                  elements: [splitCoin],
                  type: `0x2::coin::Coin<${SUI_COIN_TYPE}>`
                });

                // Target stablecoin type - should be USDC
                const targetCoinType = USDC_COIN_TYPE;
                const poolId = 'b01b068bd0360bb3308b81eb42386707e460b7818816709b7f51e1635d542d40';

                // Use optimized price limit based on transaction size and amount
                // For the problematic amount range around 0.16 SUI, use the value that worked previously
                const sqrtPriceLimit = (amountInSUI >= 0.15 && amountInSUI <= 0.2) ? 
                  "79226673515401279992447579000" : // More flexible for problematic range
                  amountInSUI < 0.1 ? 
                    "79226673515401279992447579000" : // Slightly more flexible for small amounts
                    "79226673515401279992447579055"; // Standard for regular amounts
                
                // Use swap_b2a to swap FROM token B (SUI) TO token A (USDC)
                txb.moveCall({
                  target: `0x4f920e1ef6318cfba77e20a0538a419a5a504c14230169438b99aba485db40a6::pool_script::swap_b2a`,
                  typeArguments: [targetCoinType, SUI_COIN_TYPE],
                  arguments: [
                    txb.object("0x9774e359588ead122af1c7e7f64e14ade261cfeecdb5d0eb4a5b3b4c8ab8bd3e"),
                    txb.object(poolId),
                    coinVector,
                    txb.pure.bool(true), // Set to true for swapping B->A (SUI to USDC)
                    txb.pure.u64(suiAmountMIST),
                    txb.pure.u64(effectiveMinAmountOut),
                    txb.pure.u128(sqrtPriceLimit),
                    txb.object('0x6')
                  ]
                });
                
              } catch (moveCallError) {
                console.error('Error building swap transaction:', moveCallError);
                throw moveCallError;
              }
            },
            { gasBudget: 100000000 } // Higher gas budget for swap
          );
          
          console.log('Swap transaction successful:', txResult);
          
          // Find the created coin object ID from transaction effects
          let createdCoinId = null;
          // Use optional chaining and type checking instead of type assertion
          if (txResult && typeof txResult === 'object' && 'effects' in txResult) {
            const effects = txResult.effects as {
              created?: Array<{
                reference?: { objectId?: string };
                owner?: { AddressOwner?: string };
                objectType?: string;
              }>
            };
            
            if (effects.created && Array.isArray(effects.created) && effects.created.length > 0) {
              // First log all created objects for debugging
              console.log('Created objects in transaction:', 
                effects.created.map(obj => ({
                  id: obj.reference?.objectId,
                  type: obj.objectType,
                  owner: obj.owner?.AddressOwner
                }))
              );
              
              // Improved detection for USDC coins with multiple patterns
              const usdcPatterns = [
                new RegExp(USDC_COIN_TYPE.replace(/[:]/g, '\\:')),  // Exact match with escaping
                /Coin<.*usdc::USDC>/i,
                /Coin<.*USDC>/i,
                /0x[a-f0-9]+::usdc::USDC/i,
                /usdc::USDC/i,
                /coin::Coin<.*usdc::USDC>/i
              ];
              
              // Check for all coins owned by the user first
              const userOwnedCoins = effects.created.filter(created => 
                created.reference?.objectId && 
                created.owner?.AddressOwner === (session.account?.userAddr || '') &&
                created.objectType && 
                created.objectType.includes('Coin')
              );
              
              console.log(`Found ${userOwnedCoins.length} coins owned by user:`, 
                userOwnedCoins.map(coin => ({
                  id: coin.reference?.objectId,
                  type: coin.objectType
                }))
              );
              
              // Direct match using exact USDC coin type
              for (const created of userOwnedCoins) {
                if (created.objectType && created.objectType.includes(USDC_COIN_TYPE)) {
                  createdCoinId = created.reference?.objectId;
                  console.log(`Found exact match for USDC coin: ${createdCoinId}`);
                  break;
                }
              }
              
              // If no direct match, try pattern matching
              if (!createdCoinId) {
                for (const created of userOwnedCoins) {
                  if (created.objectType) {
                    // Check if this is a USDC coin by looking at the objectType using any of our patterns
                    for (const pattern of usdcPatterns) {
                      if (pattern.test(created.objectType)) {
                        createdCoinId = created.reference?.objectId;
                        console.log(`Found USDC coin ID with pattern ${pattern}: ${createdCoinId}`);
                        break;
                      }
                    }
                    if (createdCoinId) break;
                  }
                }
              }
              
              // If still no match, check for non-SUI coins as a fallback
              if (!createdCoinId && userOwnedCoins.length > 0) {
                for (const created of userOwnedCoins) {
                  // If it's a coin but NOT a SUI coin, it's likely our USDC
                  if (created.objectType && 
                      !created.objectType.includes('sui::SUI') && 
                      created.objectType.includes('Coin')) {
                    createdCoinId = created.reference?.objectId;
                    console.log('Found non-SUI coin, assuming USDC:', createdCoinId);
                    break;
                  }
                }
              }
              
              // Last resort - just use the first coin owned by the user if there's only one
              if (!createdCoinId && userOwnedCoins.length === 1) {
                createdCoinId = userOwnedCoins[0].reference?.objectId;
                console.log('Fallback: Using only created coin as USDC:', createdCoinId);
              }
            }
          }
          
          // If we still don't have a coin ID, also check mutated objects
          if (!createdCoinId && txResult && typeof txResult === 'object' && 'effects' in txResult) {
            try {
              const effects = txResult.effects as {
                mutated?: Array<{
                  reference?: { objectId?: string };
                  owner?: { AddressOwner?: string };
                  objectType?: string;
                }>
              };
              
              if (effects.mutated && Array.isArray(effects.mutated)) {
                console.log('Checking mutated objects for USDC coin...');
                const userMutatedCoins = effects.mutated.filter(mutated => 
                  mutated.reference?.objectId && 
                  mutated.owner?.AddressOwner === (session.account?.userAddr || '') &&
                  mutated.objectType && 
                  mutated.objectType.includes('Coin') &&
                  !mutated.objectType.includes('sui::SUI')
                );
                
                console.log(`Found ${userMutatedCoins.length} mutated non-SUI coins owned by user`);
                
                // Try to find USDC in mutated coins
                for (const mutated of userMutatedCoins) {
                  if (mutated.objectType && 
                      (mutated.objectType.includes('usdc') || 
                       mutated.objectType.includes('USDC') ||
                       mutated.objectType.includes(USDC_COIN_TYPE))) {
                    createdCoinId = mutated.reference?.objectId;
                    console.log('Found mutated USDC coin ID:', createdCoinId);
                    break;
                  }
                }
                
                // If still not found but we have only one non-SUI coin, use it
                if (!createdCoinId && userMutatedCoins.length === 1) {
                  createdCoinId = userMutatedCoins[0].reference?.objectId;
                  console.log('Using only mutated non-SUI coin as USDC:', createdCoinId);
                }
              }
            } catch (extractionError) {
              console.error('Error extracting from mutated objects:', extractionError);
            }
          }
          
          // If we still don't have a coin ID, try querying the blockchain
          if (!createdCoinId && session.account) {
            try {
              console.log('Attempting to query blockchain for USDC coins...');
              // We'll make this request conditionally to avoid unnecessary API calls
              const suiClient = new SuiClient({ url: getJsonRpcUrl() });
              
              // Look for USDC coins owned by the user
              const userCoins = await suiClient.getCoins({
                owner: session.account.userAddr,
                coinType: USDC_COIN_TYPE
              });
              
              if (userCoins.data && userCoins.data.length > 0) {
                // Sort by balance (descending) to get the most recently received coin
                userCoins.data.sort((a, b) => {
                  const diff = BigInt(b.balance) - BigInt(a.balance);
                  return diff > BigInt(0) ? 1 : diff < BigInt(0) ? -1 : 0;
                });
                
                createdCoinId = userCoins.data[0].coinObjectId;
                console.log('Found USDC coin by querying blockchain:', createdCoinId);
              } else {
                console.log('No USDC coins found for user on blockchain');
              }
            } catch (queryError) {
              console.error('Error querying blockchain for USDC coins:', queryError);
            }
          }
          
          // If we still don't have a coin ID, log an error but don't fail completely
          if (!createdCoinId) {
            console.error('Failed to extract created USDC coin ID from transaction result');
            
            // Include error info in the response but return success status
            return res.status(200).json({ 
              digest: txResult.digest,
              status: txResult.status,
              gasUsed: txResult.gasUsed,
              error: 'Could not identify the swapped USDC coin object',
              // Still return transaction response for debugging
              transactionResponse: txResult 
            });
          } else {
            console.log('Successfully extracted USDC coin ID:', createdCoinId);
          }
          
          return res.status(200).json({ 
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed,
            createdCoinId: createdCoinId
          });
        } catch (error) {
          console.error('Error executing swap-only transaction:', error);
          
          // Check if it's an authentication error
          if (error instanceof Error && 
              (error.message.includes('proof verify failed') ||
               error.message.includes('Session expired') ||
               error.message.includes('re-authenticate'))) {
            
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
            error: error instanceof Error ? error.message : 'Failed to execute swap',
            details: error instanceof Error ? error.stack : String(error),
            requireRelogin: false
          });
        }
        break;

      case 'activateCircle':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please authenticate first.' });
        }

        try {
          // Validate the circleId from the request
          const circleId = req.body.circleId;
          if (!circleId) {
            return res.status(400).json({ error: 'Circle ID is required' });
          }

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

          // Execute the activate circle transaction using ZkLoginService's sendTransaction method
          const txResult = await instance.sendTransaction(
            session.account,
            (txb: Transaction) => {
              txb.moveCall({
                target: `${PACKAGE_ID}::njangi_circles::activate_circle`,
                arguments: [
                  txb.object(circleId)
                ],
              });
            }
          );

          return res.status(200).json({
            status: 'success',
            digest: txResult.digest,
            gasUsed: txResult.gasUsed
          });
        } catch (error) {
          console.error('Error activating circle:', error);
          
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
            error: error instanceof Error ? error.message : 'Unknown error',
            details: JSON.stringify(error),
            requireRelogin: error instanceof ZkLoginError ? error.requireRelogin : false
          });
        }

      case 'setRotationPosition': {
        // Extract parameters properly
        const { account, circleId, memberAddress, position } = req.body;
        
        // Validate required parameters
        if (!account) {
          return res.status(400).json({ error: 'account is required' });
        }
        if (!circleId) {
          return res.status(400).json({ error: 'circleId is required' });
        }
        if (typeof memberAddress === 'undefined') {
          return res.status(400).json({ error: 'memberAddress is required' });
        }
        if (typeof position === 'undefined') {
          return res.status(400).json({ error: 'position is required' });
        }

        try {
          console.log(`Setting rotation position for member ${memberAddress} to position ${position} in circle ${circleId}`);
          
          // Get the ZkLoginService instance
          const zkLoginService = ZkLoginService.getInstance();
          
          // Send the transaction using the service's sendTransaction method
          const result = await zkLoginService.sendTransaction(
            account,
            (txb) => {
              // Build the transaction in this callback
              txb.moveCall({
                target: `${PACKAGE_ID}::njangi_circles::set_rotation_position`,
                arguments: [
                  txb.object(circleId), // circle
                  txb.pure.address(memberAddress.toLowerCase().startsWith('0x') ? memberAddress.toLowerCase() : `0x${memberAddress.toLowerCase()}`), // Normalize the address
                  txb.pure.u64(position), // position as u64 integer
                ],
              });
            }
          );
          
          return res.status(200).json({
            digest: result.digest,
            status: result.status,
            message: `Set rotation position for member ${memberAddress} to position ${position}`,
            gasUsed: result.gasUsed,
          });
        } catch (error) {
          console.error('Error setting rotation position:', error);
          
          // Handle authentication errors
          if (error instanceof Error && 
              (error.message.includes('authentication') || 
               error.message.includes('login') || 
               error.message.includes('session') ||
               error.message.includes('expired'))) {
            return res.status(401).json({
              error: error.message,
              requireRelogin: true
            });
          }
          
          return res.status(500).json({
            error: 'Failed to set rotation position',
            details: error instanceof Error ? error.message : String(error),
            requireRelogin: error instanceof ZkLoginError ? error.requireRelogin : false
          });
        }
      }

      case 'reorderRotationPositions': {
        // Extract parameters properly
        const { account, circleId, newOrder } = req.body;
        
        // Validate required parameters
        if (!account) {
          return res.status(400).json({ error: 'account is required' });
        }
        if (!circleId) {
          return res.status(400).json({ error: 'circleId is required' });
        }
        if (!newOrder || !Array.isArray(newOrder) || newOrder.length === 0) {
          return res.status(400).json({ error: 'newOrder is required and must be a non-empty array' });
        }

        try {
          console.log(`Reordering rotation positions for circle ${circleId} with ${newOrder.length} members`);
          
          // Get the ZkLoginService instance
          const zkLoginService = ZkLoginService.getInstance();
          
          // Send the transaction using the service's sendTransaction method
          const result = await zkLoginService.sendTransaction(
            account,
            (txb) => {
              // Convert the addresses array to an array of arguments
              const addressArgs = newOrder.map(address => 
                txb.pure.address(address.toLowerCase())
              );
              
              // Build the transaction in this callback
              txb.moveCall({
                target: `${PACKAGE_ID}::njangi_circles::reorder_rotation_positions_entry`,
                arguments: [
                  txb.object(circleId), // circle
                  txb.makeMoveVec({ elements: addressArgs, type: 'address' }),
                ],
              });
            }
          );
          
          return res.status(200).json({
            digest: result.digest,
            status: result.status,
            message: `Reordered rotation positions for circle ${circleId}`,
            gasUsed: result.gasUsed,
          });
        } catch (error) {
          console.error('Error reordering rotation positions:', error);
          
          // Handle authentication errors
          if (error instanceof Error && 
              (error.message.includes('authentication') || 
               error.message.includes('login') || 
               error.message.includes('session') ||
               error.message.includes('expired'))) {
            return res.status(401).json({
              error: error.message,
              requireRelogin: true
            });
          }
          
          return res.status(500).json({
            error: 'Failed to reorder rotation positions',
            details: error instanceof Error ? error.message : String(error),
            requireRelogin: error instanceof ZkLoginError ? error.requireRelogin : false
          });
        }
      }

      case 'depositUsdcDirect':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please authenticate first.' });
        }

        try {
          // Validate required parameters
          const { circleId, walletId, usdcAmount, isSecurityDeposit } = req.body;
          if (!circleId || !walletId || !usdcAmount) {
            return res.status(400).json({ 
              error: 'Missing required parameters: circleId, walletId, usdcAmount'
            });
          }

          // Convert USDC amount to BigInt if it's not already
          const usdcAmountMicroUnits = typeof usdcAmount === 'string' ? 
            BigInt(usdcAmount) : BigInt(usdcAmount);

          // Validate session
          const session = validateSession(sessionId, 'sendTransaction');
          if (!session.account) {
            sessions.delete(sessionId);
            clearSessionCookie(res);
            return res.status(401).json({ 
              error: 'Invalid session: No account data found. Please authenticate first.'
            });
          }

          console.log(`Creating direct USDC deposit transaction for circle ${circleId}, wallet ${walletId}, amount ${usdcAmountMicroUnits} (${Number(usdcAmountMicroUnits) / 1e6} USDC)`);
          console.log(`Operation type: ${isSecurityDeposit ? 'Security Deposit' : 'Contribution'}`);

          // Execute the transaction
          const txResult = await instance.sendTransaction(
            session.account,
            async (txb: Transaction) => {
              txb.setSender(session.account!.userAddr);
              
              // Use SuiClient to get coins of USDC type from the user's wallet
              const suiClient = new SuiClient({ url: getJsonRpcUrl() });
              const coinsResponse = await suiClient.getCoins({
                owner: session.account!.userAddr,
                coinType: USDC_COIN_TYPE
              });
              
              console.log(`Found ${coinsResponse.data.length} USDC coins in wallet`);
              
              if (coinsResponse.data.length === 0) {
                throw new Error("No USDC coins found in wallet");
              }
              
              // Calculate total available balance
              let totalAvailable = BigInt(0);
              for (const coin of coinsResponse.data) {
                totalAvailable += BigInt(coin.balance);
              }
              
              console.log(`Total available: ${formatMicroUnits(totalAvailable)} USDC`);
              console.log(`Required amount: ${formatMicroUnits(usdcAmountMicroUnits)} USDC`);
              
              // Ensure we have enough balance
              if (totalAvailable < usdcAmountMicroUnits) {
                throw new Error(`Insufficient USDC balance. Need ${formatMicroUnits(usdcAmountMicroUnits)} USDC but only have ${formatMicroUnits(totalAvailable)} USDC.`);
              }
              
              // Use the first coin as primary, we'll merge others if needed
              const primaryCoinId = coinsResponse.data[0].coinObjectId;
              
              // Call the appropriate deposit function based on operation type
              if (isSecurityDeposit) {
                console.log(`Calling njangi_circles::member_deposit_security_deposit for USDC`);
                
                txb.moveCall({
                  target: `${PACKAGE_ID}::njangi_circles::member_deposit_security_deposit`,
                  arguments: [
                    txb.object(circleId),     // Arg 0: circle
                    txb.object(walletId),     // Arg 1: wallet
                    txb.object(primaryCoinId),// Arg 2: stablecoin (USDC Coin object)
                    txb.object("0x6")         // Arg 3: clock
                  ],
                  typeArguments: [USDC_COIN_TYPE]
                });
              } else {
                console.log(`Calling njangi_circles::contribute_from_wallet for USDC`);
                
                txb.moveCall({
                  target: `${PACKAGE_ID}::njangi_circles::contribute_from_wallet`,
                  arguments: [
                    txb.object(circleId),     // Arg 0: circle
                    txb.object(walletId),     // Arg 1: wallet
                    txb.object(primaryCoinId),// Arg 2: contribution_coin (USDC Coin object)
                    txb.object("0x6")         // Arg 3: clock
                  ],
                  typeArguments: [USDC_COIN_TYPE]
                });
              }
            },
            { gasBudget: 100000000 } // Higher gas budget for complex transaction
          );
          
          console.log('Direct USDC deposit transaction successful:', txResult);
          return res.status(200).json({ 
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed
          });
        } catch (error) {
          console.error('Direct USDC deposit error:', error);
          
          if (error instanceof Error && 
              (error.message.includes('proof verify failed') ||
               error.message.includes('Session expired'))) {
            
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
            error: error instanceof Error ? error.message : 'Failed to process USDC deposit'
          });
        }
        break;

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