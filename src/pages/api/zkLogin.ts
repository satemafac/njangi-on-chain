import { NextApiRequest, NextApiResponse } from 'next';
import { ZkLoginService, SetupData, AccountData, OAuthProvider } from '@/services/zkLoginService';
import { Transaction } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';
import { PACKAGE_ID } from '../../services/circle-service';
import { priceService } from '../../services/price-service';

// Add at the top with other imports
interface RPCError extends Error {
  code?: number;
}

// Constants
const MAX_EPOCH = 2; // Number of epochs to keep session alive (1 epoch ~= 24h)
const PROCESSING_COOLDOWN = 30000; // 30 seconds between processing attempts for the same session

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

// Comment out unused function
// For testing, you can use a temporary keypair
// In production, this would be securely managed with proper key management
/*
const getAdminKeypair = () => {
  // WARNING: This is just for development - never hardcode keys in production code
  // You would fetch this from a secure environment variable or key management system
  const DEV_ADMIN_SECRET = process.env.DEV_ADMIN_SECRET || '';
  return Ed25519Keypair.fromSecretKey(Buffer.from(DEV_ADMIN_SECRET, 'hex'));
};
*/

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

      case 'swapAndContribute':
        try {
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

          if (!req.body.circleId || !req.body.walletId || !req.body.swapPayload) {
            return res.status(400).json({ error: 'Circle ID, wallet ID, and swap payload are required' });
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
            console.log('Preparing swap and contribute transaction');
            
            // First execute the swap transaction using the provided payload
            console.log('Executing swap transaction...');
            const swapTxResult = await instance.sendTransaction(
              account,
              (txBlock) => {
                // Use the prepared swap payload
                const swapPayload = req.body.swapPayload;
                
                // Add all transactions from the swap payload to our transaction block
                // In an actual implementation, you would need to parse the payload properly
                // This is a simplified approach
                if (swapPayload.transactions) {
                  try {
                    for (const tx of swapPayload.transactions) {
                      if (tx.MoveCall) {
                        // Extract the MoveCall parts
                        const target = `${tx.MoveCall.package}::${tx.MoveCall.module}::${tx.MoveCall.function}`;
                        
                        // Create valid arguments
                        const args = [];
                        if (Array.isArray(tx.MoveCall.arguments)) {
                          for (const arg of tx.MoveCall.arguments) {
                            try {
                              if (arg && typeof arg === 'object') {
                                if ('Object' in arg && arg.Object?.objectId) {
                                  args.push(txBlock.object(arg.Object.objectId));
                                } else if ('Pure' in arg) {
                                  args.push(txBlock.pure(arg.Pure));
                                }
                                // Skip arguments we can't convert
                              }
                            } catch (argError) {
                              console.error('Error processing argument:', argError);
                              // Continue with next argument
                            }
                          }
                        }
                        
                        // Add the move call with valid arguments
                        txBlock.moveCall({
                          target,
                          arguments: args,
                          typeArguments: tx.MoveCall.typeArguments || []
                        });
                      }
                    }
                  } catch (txError) {
                    console.error('Error processing swap payload:', txError);
                    throw new Error('Invalid swap transaction payload');
                  }
                }
              },
              { gasBudget: 150000000 } // Higher gas budget for complex swap operation
            );
            
            console.log('Swap transaction successful:', swapTxResult);

            // Now execute the contribution transaction
            console.log('Executing contribution transaction...');
            const contributeTxResult = await instance.sendTransaction(
              account,
              (txBlock) => {
                txBlock.moveCall({
                  target: `${PACKAGE_ID}::njangi_circle::contribute_from_custody`,
                  arguments: [
                    txBlock.object(req.body.circleId),
                    txBlock.object(req.body.walletId),
                    txBlock.object('0x6'), // Clock object
                  ]
                });
              },
              { gasBudget: 100000000 }
            );
            
            console.log('Contribution transaction successful:', contributeTxResult);
            
            return res.status(200).json({ 
              swapDigest: swapTxResult.digest,
              contributeDigest: contributeTxResult.digest,
              success: true
            });
          } catch (txError) {
            console.error('Swap and contribute transaction error:', txError);
            console.error('Error type:', typeof txError);
            console.error('Error message:', txError instanceof Error ? txError.message : String(txError));
            
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
            
            // For other errors, keep the session but return error with more detail
            return res.status(500).json({ 
              error: txError instanceof Error ? txError.message : 'Failed to swap and contribute',
              details: txError instanceof Error ? txError.stack : String(txError),
              requireRelogin: false
            });
          }
        } catch (error) {
          console.error('Error in swapAndContribute:', error);
          return res.status(500).json({ 
            error: 'Failed to swap and contribute',
            details: error instanceof Error ? error.message : String(error)
          });
        }

      case 'contributeFromCustody':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!sessionId) {
          return res.status(401).json({ error: 'No session found. Please authenticate first.' });
        }

        if (!req.body.circleId || !req.body.walletId) {
          return res.status(400).json({ error: 'Circle ID and wallet ID are required' });
        }

        try {
          // Log the transaction attempt
          console.log('Processing contribution from custody wallet:', {
            sessionId,
            address: account.userAddr,
            circleId: req.body.circleId,
            walletId: req.body.walletId,
            hasSession: sessions.has(sessionId)
          });

          // Validate session with action context
          const session = validateSession(sessionId, 'contributeFromCustody');
          
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

          // Execute the transaction
          try {
            const txResult = await instance.sendTransaction(
              session.account,
              (txb: Transaction) => {
                console.log(`Building moveCall for contribute_from_custody`);
                
                // Call the contribute_from_custody function
                txb.moveCall({
                  target: `${PACKAGE_ID}::njangi_circle::contribute_from_custody`,
                  arguments: [
                    txb.object(req.body.circleId),   // circle object
                    txb.object(req.body.walletId),   // custody wallet
                    txb.pure.address(account.userAddr), // member address
                    txb.object('0x6'),               // clock object
                  ]
                });
              },
              { gasBudget: 100000000 } // Increase gas budget
            );
            
            console.log('Contribution transaction successful:', txResult);
            return res.status(200).json({ 
              digest: txResult.digest,
              status: txResult.status,
              gasUsed: txResult.gasUsed
            });
          } catch (txError) {
            console.error('Contribution transaction error:', txError);
            return res.status(500).json({ 
              error: txError instanceof Error ? txError.message : 'Failed to execute contribution transaction',
              requireRelogin: txError instanceof Error && 
                (txError.message.includes('expired') || txError.message.includes('proof')) 
            });
          }
        } catch (err) {
          console.error('Contribution error:', err);
          return res.status(500).json({ 
            error: err instanceof Error ? err.message : 'Failed to process contribution',
            requireRelogin: err instanceof Error && 
              (err.message.includes('session') || err.message.includes('expired') || err.message.includes('proof'))
          });
        }

      case 'executeStablecoinSwap':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }

        if (!req.body.circleId || !req.body.walletId || !req.body.suiAmount) {
          return res.status(400).json({ error: 'Missing required parameters: circleId, walletId, suiAmount' });
        }

        try {
          // Ensure parameters are of the correct type
          const walletId = String(req.body.walletId);
          const suiAmount = Number(req.body.suiAmount);

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
          
          // Get the live SUI price
          const suiPrice = await priceService.getSUIPrice();
          if (!suiPrice || suiPrice <= 0) {
            return res.status(500).json({ 
              error: 'Failed to fetch current SUI price. Please try again.',
            });
          }
          
          console.log('Live SUI price for swap:', suiPrice);
          
          // Calculate stablecoin amount based on live SUI price
          // For USDC, multiply by 1e6 for correct decimals (USDC has 6 decimal places)
          const suiAmountInMoj = suiAmount * 1e9; // Convert SUI to Mist (9 decimals)
          const stablecoinAmount = Math.floor(suiAmount * suiPrice * 1e6); // USDC has 6 decimals
          
          // Execute the transaction through zkLogin
          const txResult = await instance.sendTransaction(
            session.account,
            (txb: Transaction) => {
              txb.setSender(session.account!.userAddr);
              
              // Call our new deposit_with_live_rate function
              txb.moveCall({
                target: `${PACKAGE_ID}::njangi_circle::deposit_with_live_rate`,
                arguments: [
                  txb.object(walletId), // Custody wallet ID
                  txb.splitCoins(txb.gas, [txb.pure.u64(suiAmountInMoj.toString())]), // SUI payment
                  txb.pure.u64(stablecoinAmount.toString()), // Calculated stablecoin amount based on live price
                  txb.object("0x6"), // Clock object
                ]
              });
            }
          );
          
          return res.status(200).json({ 
            digest: txResult.digest,
            status: txResult.status,
            gasUsed: txResult.gasUsed,
            suiPrice: suiPrice,
            stablecoinAmount: stablecoinAmount / 1e6 // Return human-readable amount
          });
        } catch (error) {
          console.error('Error executing stablecoin swap:', error);
          
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
          
          return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Failed to execute stablecoin swap'
          });
        }
        break;

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
          const CETUS_PACKAGE = '0x0868b71c0cba55bf0faf6c40df8c179c67a4d0ba0e79965b68b3d72d7dfbf666';
          const CETUS_GLOBAL_CONFIG = '0x6f4149091a5aea0e818e7243a13adcfb403842d670b9a2089de058512620687a';
          
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
                  txb.pure.address(CETUS_PACKAGE),
                  txb.pure.u64(BigInt(config.slippageTolerance)),
                    txb.pure.u64(BigInt(minimumSwapAmount)),
                  txb.pure.address(CETUS_GLOBAL_CONFIG),
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

          console.log(`Processing security deposit payment of ${depositAmount} to wallet ${walletId}`);

          // Execute the transaction with zkLogin
            const txResult = await instance.sendTransaction(
              session.account,
            (txb) => {
              // First, split the required coins from gas
              const [coin] = txb.splitCoins(txb.gas, [txb.pure.u64(depositAmount)]);
                
              // Then deposit to the custody wallet
                txb.moveCall({
                target: `${PACKAGE_ID}::njangi_circle::deposit_to_custody`,
                  arguments: [
                  txb.object(walletId),
                  coin,
                  txb.object('0x6'), // Clock object
                ],
              });
            }
          );
          
          console.log('Security deposit payment result:', txResult);
            return res.status(200).json({ 
              digest: txResult.digest,
              status: txResult.status,
              gasUsed: txResult.gasUsed
            });
        } catch (error) {
          console.error('Error paying security deposit:', error);
          
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
            if (error.message.includes('EWalletNotActive')) {
              return res.status(400).json({
                error: 'The custody wallet is not active'
              });
            }
            
            if (error.message.includes('ENotWalletOwner')) {
              return res.status(403).json({
                error: 'You are not authorized to deposit to this wallet'
              });
            }
            
            if (error.message.includes('InsufficientBalance')) {
              return res.status(400).json({
                error: 'Insufficient balance to make this deposit'
              });
            }
          }
          
          // Generic error handling
          return res.status(500).json({ 
            error: error instanceof Error ? error.message : 'Unknown error during security deposit payment'
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

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ 
      error: error instanceof Error ? error.message : 'An internal server error occurred' 
    });
  }
} 