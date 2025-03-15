import { NextApiRequest, NextApiResponse } from 'next';
import { ZkLoginService, SetupData, AccountData, OAuthProvider } from '@/services/zkLoginService';
import { Transaction } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';

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
function validateSession(sessionId: string, action: string): SetupData & { account?: AccountData } {
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
                  target: `0x564e7ab05c090f329b98b43ab1d7302df1c38c99e38684aac8201c453f9cd0d4::njangi_circle::create_circle`,
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
                console.log(`Building moveCall with package: 0x564e7ab05c090f329b98b43ab1d7302df1c38c99e38684aac8201c453f9cd0d4, module: njangi_circle, function: delete_circle`);
                console.log(`Using circleId: ${circleId} as object argument`);
                
                txb.moveCall({
                  target: `0x564e7ab05c090f329b98b43ab1d7302df1c38c99e38684aac8201c453f9cd0d4::njangi_circle::delete_circle`,
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

      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: (err as Error).message });
  }
} 