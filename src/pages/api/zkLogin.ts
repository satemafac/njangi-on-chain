import { NextApiRequest, NextApiResponse } from 'next';
import { ZkLoginService, SetupData, AccountData, OAuthProvider } from '@/services/zkLoginService';

// Simple in-memory session store (in production, use Redis or a proper session store)
const sessions = new Map<string, SetupData & { account?: AccountData }>();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { action, jwt, account, provider } = req.body;
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
        const txDigest = await instance.sendTransaction(account);
        return res.status(200).json({ digest: txDigest });

      default:
        return res.status(400).json({ error: 'Invalid action' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: (err as Error).message });
  }
} 