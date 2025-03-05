import { NextApiRequest, NextApiResponse } from 'next';
import { decodeJwt } from 'jose';
import saltService from '../../services/local-salt-service';

/**
 * API route for salt management
 * This replaces the Sui hosted salt service with our local implementation
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Extract token and client_id from request body
    const { token, client_id } = req.body;

    if (!token || !client_id) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Decode JWT to get subject and audience
    const decoded = decodeJwt(token);
    if (!decoded.sub || !decoded.aud) {
      return res.status(400).json({ error: 'Invalid JWT: missing required claims' });
    }

    // Get or create salt for this user
    const sub = decoded.sub;
    const aud = Array.isArray(decoded.aud) ? decoded.aud[0] : decoded.aud;

    // Use our salt service to get or create a salt
    const salt = await saltService.getSalt(sub, aud);
    
    // Return the salt in the same format as Sui's hosted service
    return res.status(200).json({ salt });
  } catch (error) {
    console.error('Salt service error:', error);
    return res.status(500).json({ 
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
} 