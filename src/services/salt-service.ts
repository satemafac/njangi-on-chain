/**
 * A development salt service that generates deterministic user-specific salts.
 * 
 * This service generates salts based on the user's JWT sub and aud claims to ensure
 * consistent but user-specific salts for development.
 * 
 * WARNING: Do not use in production! Use a proper salt management service.
 */

'use strict';

import express from 'express';
import cors from 'cors';
import { decodeJwt, JWTPayload } from 'jose';
import { createHash, randomBytes } from 'crypto';

// Constants
const PORT = 5002;
const MAX_SALT = 2n ** 128n - 1n; // Maximum allowed salt value
const SALT_CACHE = new Map<string, string>(); // Cache salts for better performance

const app = express();

// Parse JSON requests
app.use(express.json());

// Enable CORS for development
app.use(cors());

// Validate JWT claims
function validateJwtClaims(decoded: JWTPayload): void {
  if (!decoded.sub || !decoded.aud) {
    throw new Error('Missing required JWT claims (sub or aud)');
  }

  if (!decoded.exp || !decoded.iat) {
    throw new Error('Missing required JWT claims (exp or iat)');
  }

  const now = Math.floor(Date.now() / 1000);
  if (decoded.exp < now) {
    throw new Error('JWT has expired');
  }
}

// Generate a deterministic salt based on the user's sub and aud claims
function generateDeterministicSalt(sub: string, aud: string): string {
    // Create a cache key
    const cacheKey = `${sub}:${aud}`;
    
    // Check cache first
    const cachedSalt = SALT_CACHE.get(cacheKey);
    if (cachedSalt) {
        return cachedSalt;
    }

    // Create a hash combining sub and aud with additional entropy
    const entropy = randomBytes(32).toString('hex');
    const hash = createHash('sha256')
        .update(`${sub}:${aud}:${entropy}`)
        .digest('hex');
    
    // Convert to BigInt and ensure it's within bounds
    let salt = BigInt('0x' + hash);
    salt = salt % MAX_SALT; // Ensure salt is within valid range
    
    const saltStr = salt.toString();
    
    // Cache the result
    SALT_CACHE.set(cacheKey, saltStr);
    
    return saltStr;
}

app.post('/get-salt', (req: express.Request, res: express.Response) => {
    try {
        const { token } = req.body;
        
        if (!token) {
            return res.status(400).json({ error: 'JWT token is required' });
        }

        // Decode and validate the JWT
        const decoded = decodeJwt(token);
        
        try {
            validateJwtClaims(decoded);
        } catch (error) {
            return res.status(400).json({ 
                error: `JWT validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            });
        }

        // Handle array aud claim
        const audience = Array.isArray(decoded.aud) ? decoded.aud[0] : decoded.aud || '';
        if (!audience) {
            return res.status(400).json({ error: 'Invalid JWT: missing audience claim' });
        }

        // Generate deterministic salt based on sub and aud
        const salt = generateDeterministicSalt(decoded.sub!, audience);
        
        // Validate generated salt
        try {
            const saltBigInt = BigInt(salt);
            if (saltBigInt <= 0n || saltBigInt > MAX_SALT) {
                throw new Error('Generated salt is out of valid range');
            }
        } catch (error) {
            return res.status(500).json({ 
                error: `Salt validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
            });
        }

        res.json({ 
            salt,
            exp: decoded.exp,
            iat: decoded.iat
        });
    } catch (error) {
        console.error('Salt generation error:', error);
        res.status(500).json({ 
            error: `Failed to generate salt: ${error instanceof Error ? error.message : 'Unknown error'}`
        });
    }
});

// Add endpoint to clear salt cache if needed
app.post('/clear-salt-cache', (req: express.Request, res: express.Response) => {
    try {
        SALT_CACHE.clear();
        res.json({ message: 'Salt cache cleared successfully' });
    } catch (error) {
        res.status(500).json({ 
            error: `Failed to clear salt cache: ${error instanceof Error ? error.message : 'Unknown error'}`
        });
    }
});

app.get('/ping', (req: express.Request, res: express.Response) => {
    res.status(200).send('pong\n');
});

app.listen(PORT, () => {
    console.log(`Salt service running on http://localhost:${PORT}`);
}); 