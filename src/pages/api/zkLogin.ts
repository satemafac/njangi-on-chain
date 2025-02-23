import { NextApiRequest, NextApiResponse } from 'next';
import { ZkLoginService, SetupData, AccountData, OAuthProvider } from '@/services/zkLoginService';
import { Transaction } from '@mysten/sui/transactions';

// Add at the top with other imports
interface RPCError extends Error {
  code?: number;
}

// Simple in-memory session store (in production, use Redis or a proper session store)
const sessions = new Map<string, SetupData & { account?: AccountData }>();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { action, jwt, account, provider, circleData } = req.body;
    const sessionId = req.cookies['session-id'] || crypto.randomUUID();
    const instance = ZkLoginService.getInstance();

    // Set session cookie if not exists
    if (!req.cookies['session-id']) {
      res.setHeader('Set-Cookie', `session-id=${sessionId}; Path=/; HttpOnly; SameSite=Lax`);
    }

    switch (action) {
      case 'beginLogin':
        const { loginUrl, setupData: initialSetup } = await instance.beginLogin(provider as OAuthProvider);
        // Store setup data in server session
        sessions.set(sessionId, initialSetup);
        return res.status(200).json({ loginUrl });

      case 'handleCallback':
        if (!jwt) {
          return res.status(400).json({ error: 'JWT is required' });
        }
        // Get setup data from server session
        const savedSetup = sessions.get(sessionId);
        if (!savedSetup) {
          return res.status(400).json({ error: 'Session expired' });
        }
        const result = await instance.handleCallback(jwt, savedSetup);
        // Store account data in server session
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
        sessions.set(sessionId, { ...savedSetup, account: accountData });
        return res.status(200).json(accountData);

      case 'sendTransaction':
        if (!account) {
          return res.status(400).json({ error: 'Account data is required' });
        }
        try {
          const txDigest = await instance.sendTransaction(
            account,
            (txb: Transaction) => {
              // Set sender before building transaction
              txb.setSender(account.userAddr);
              
              txb.moveCall({
                target: `0xd9ecf9d1749fc36770a1c3d379428383774e796169154095671e7be2c29f39ad::njangi_circle::create_circle`,
                arguments: [
                  txb.pure.string(circleData.name),
                  txb.pure.u64(BigInt(circleData.contribution_amount)),
                  txb.pure.u64(BigInt(circleData.security_deposit)),
                  txb.pure.u64(circleData.cycle_length),
                  txb.pure.u64(circleData.cycle_day),
                  txb.pure.u8(circleData.circle_type),
                  txb.pure.u64(circleData.max_members),
                  txb.pure.u8(circleData.rotation_style),
                  txb.pure.vector('bool', circleData.penalty_rules),
                  txb.pure.option('u8', circleData.goal_type?.some),
                  txb.pure.option('u64', circleData.target_amount?.some ? BigInt(circleData.target_amount.some) : null),
                  txb.pure.option('u64', circleData.target_date?.some ? BigInt(circleData.target_date.some) : null),
                  txb.pure.bool(circleData.verification_required),
                  txb.object("0x6")  // Clock object
                ]
              });
            }
          );
          return res.status(200).json({ digest: txDigest });
        } catch (err) {
          // Check for any signature/proof/verification related errors
          if (err instanceof Error && 
              (err.message.toLowerCase().includes('invalid user signature') || 
               err.message.toLowerCase().includes('groth16 proof verify failed') ||
               err.message.toLowerCase().includes('signature is not valid') ||
               err.message.toLowerCase().includes('cryptographic error') ||
               (err as RPCError).code === -32002)) {
            // Clear the session and force re-authentication
            sessions.delete(sessionId);
            return res.status(401).json({ 
              error: 'Your session has expired. Please sign in again to refresh your credentials.',
              requireReauth: true 
            });
          }
          // Handle other transaction errors
          console.error('Transaction error:', err);
          return res.status(500).json({ 
            error: 'Failed to execute transaction. Please try again.',
            details: err instanceof Error ? err.message : 'Unknown error'
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