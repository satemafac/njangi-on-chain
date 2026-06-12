/**
 * A production-ready salt service that manages user-specific salts with database persistence.
 * 
 * This service supports both SQLite (local) and PostgreSQL (Heroku) databases,
 * with encryption and recovery mechanisms, following Sui zkLogin best practices.
 */

'use strict';

import express from 'express';
import cors from 'cors';
import { createRemoteJWKSet, decodeJwt, jwtVerify, JWTPayload } from 'jose';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { getDatabaseAdapter, DatabaseAdapter } from './postgres-adapter';

// Constants
const PORT = process.env.PORT || 5002;
const MAX_SALT = 2n ** 128n - 1n; // Maximum allowed salt value
const ENCRYPTION_KEY_PATH = './.encryption-key';

// JWKS endpoints for the OAuth providers zkLogin supports (iss → JWKS URL).
// Google issues tokens under both iss spellings.
const PROVIDER_JWKS_URLS: Record<string, string> = {
  'https://accounts.google.com': 'https://www.googleapis.com/oauth2/v3/certs',
  'accounts.google.com': 'https://www.googleapis.com/oauth2/v3/certs',
  'https://www.facebook.com': 'https://www.facebook.com/.well-known/oauth/openid/jwks/',
  'https://appleid.apple.com': 'https://appleid.apple.com/auth/keys',
};

// Module-level cache of remote JWK sets — createRemoteJWKSet memoizes keys
// internally, so each issuer costs at most one HTTPS fetch per key rotation.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getProviderJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(PROVIDER_JWKS_URLS[issuer]));
    jwksCache.set(issuer, jwks);
  }
  return jwks;
}

// Audiences (OAuth client IDs) salts may be issued for. SALT_ALLOWED_AUDIENCES
// is a comma-separated override for standalone deployments; otherwise fall
// back to the app's configured client IDs.
function getAllowedAudiences(): string[] {
  const fromEnv = (process.env.SALT_ALLOWED_AUDIENCES || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const clientIds = [
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
    process.env.NEXT_PUBLIC_FACEBOOK_CLIENT_ID,
    process.env.NEXT_PUBLIC_APPLE_CLIENT_ID,
  ].filter((value): value is string => Boolean(value));
  return [...new Set([...fromEnv, ...clientIds])];
}

/**
 * Verify the OAuth JWT signature against the provider JWKS and validate
 * iss + aud before any salt is issued or recovered. A salt handed out for
 * an unverified (sub, aud) lets an attacker deanonymize or pre-seed a
 * victim's zkLogin address, so decode-without-verify is never acceptable.
 */
async function verifyOAuthJwt(token: string): Promise<JWTPayload> {
  // Unverified decode is used ONLY to route to the right provider JWKS;
  // jwtVerify re-checks `iss` against the same pinned value after the
  // signature is validated.
  const unverified = decodeJwt(token);
  const issuer = unverified.iss;
  if (!issuer || !PROVIDER_JWKS_URLS[issuer]) {
    throw new Error(`Unsupported or missing JWT issuer: ${issuer ?? '<none>'}`);
  }

  const audiences = getAllowedAudiences();
  if (audiences.length === 0) {
    throw new Error(
      'No allowed OAuth audiences configured — set SALT_ALLOWED_AUDIENCES or the NEXT_PUBLIC_*_CLIENT_ID variables',
    );
  }

  const { payload } = await jwtVerify(token, getProviderJwks(issuer), {
    issuer,
    audience: audiences,
  });
  return payload;
}

// Define response type for salt requests
interface SaltResponse {
  salt: string;
  exp?: number;
  iat?: number;
  recoveryCode?: string;
  recoveryMessage?: string;
  message?: string;
}

// Initialize app
const app = express();

// Parse JSON requests
app.use(express.json());

// Enable CORS for all origins
app.use(cors());

// Database and encryption setup
let encryptionKey: Buffer;
let dbAdapter: DatabaseAdapter;

// Memory cache for encryption keys on Heroku (since filesystem is ephemeral)
const memoryEncryptionKey = new Map<string, Buffer>();

async function setup() {
  try {
    // Handle encryption key based on environment
    if (process.env.NODE_ENV === 'production') {
      // In production (Heroku), use environment variable or generate a new key
      if (memoryEncryptionKey.has('main')) {
        encryptionKey = memoryEncryptionKey.get('main')!;
      } else if (process.env.ENCRYPTION_KEY) {
        // Use base64-encoded encryption key from environment variable
        encryptionKey = Buffer.from(process.env.ENCRYPTION_KEY, 'base64');
        memoryEncryptionKey.set('main', encryptionKey);
      } else {
        // Generate and store a new encryption key in memory
        encryptionKey = randomBytes(32); // 256 bits
        memoryEncryptionKey.set('main', encryptionKey);
        
        // Log the key so it can be saved to environment variables (only show this once during setup)
        console.log('Generated new encryption key. Add this to your environment variables:');
        console.log(`ENCRYPTION_KEY=${encryptionKey.toString('base64')}`);
      }
    } else {
      // In development, use file-based storage
      try {
        encryptionKey = await fs.readFile(ENCRYPTION_KEY_PATH);
      } catch {
        // Generate and save a new encryption key
        encryptionKey = randomBytes(32); // 256 bits
        await fs.writeFile(ENCRYPTION_KEY_PATH, encryptionKey);
        console.log('Generated new encryption key');
      }
    }

    // Initialize database adapter
    dbAdapter = await getDatabaseAdapter();
    await dbAdapter.setup();

    console.log('Database initialized');
  } catch (error) {
    console.error('Setup error:', error);
    process.exit(1);
  }
}

// Encrypt data using AES-256-GCM
function encrypt(data: string): { encrypted: Buffer, iv: Buffer, tag: Buffer } {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv, { authTagLength: 16 });
  
  const encrypted = Buffer.concat([
    cipher.update(data, 'utf8'),
    cipher.final()
  ]);
  
  const tag = cipher.getAuthTag();
  
  return { encrypted, iv, tag };
}

// Decrypt data
function decrypt(encrypted: Buffer, iv: Buffer, tag: Buffer): string {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  
  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]).toString('utf8');
}

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

// Generate a secure random salt
function generateSecureRandomSalt(): string {
  // Generate 16 random bytes (128 bits)
  const randomValue = randomBytes(16);
  
  // Convert to BigInt and ensure it's within bounds
  let salt = BigInt('0x' + randomValue.toString('hex'));
  salt = salt % MAX_SALT; // Ensure salt is within valid range
  
  return salt.toString();
}

// Generate a recovery code for a salt
function generateRecoveryCode(): string {
  return randomBytes(12).toString('hex').toUpperCase();
}

// Hash a recovery code for storage
function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

// Create a new salt or retrieve existing one
async function getSalt(sub: string, aud: string): Promise<{ salt: string, recoveryCode?: string }> {
  try {
    // Check if we already have a salt for this user
    const row = await dbAdapter.getSalt(sub, aud);
    
    if (row.id && row.salt_encrypted && row.iv && row.tag) {
      // Decrypt the existing salt
      try {
        const salt = decrypt(row.salt_encrypted, row.iv, row.tag);
        return { salt };
      } catch (error) {
        console.error('Decryption error:', error);
        throw new Error('Failed to decrypt salt');
      }
    }
    
    // Generate a new salt if none exists
    const newSalt = generateSecureRandomSalt();
    
    // Encrypt the salt
    const { encrypted, iv, tag } = encrypt(newSalt);
    
    // Store the encrypted salt
    const saltId = await dbAdapter.insertSalt(sub, aud, encrypted, iv, tag);
    
    if (!saltId) {
      throw new Error('Failed to store salt');
    }
    
    // Generate recovery code
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = hashRecoveryCode(recoveryCode);
    
    // Store recovery code hash
    await dbAdapter.insertRecoveryCode(saltId, recoveryCodeHash);
    
    // Return the new salt and recovery code
    return { salt: newSalt, recoveryCode };
  } catch (error) {
    console.error('Salt retrieval error:', error);
    throw error;
  }
}

// API endpoint to get salt
app.post('/get-salt', async (req: express.Request, res: express.Response) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: 'JWT token is required' });
    }

    // Verify the JWT signature + iss/aud before issuing anything.
    let decoded: JWTPayload;
    try {
      decoded = await verifyOAuthJwt(token);
    } catch (error) {
      return res.status(401).json({
        error: `JWT verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    }

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

    // Get or create salt
    const { salt, recoveryCode } = await getSalt(decoded.sub!, audience);
    
    // Generate new recovery code if requested
    const generateRecovery = req.body.generateRecovery === true;
    let newRecoveryCode: string | undefined = undefined;
    
    if (generateRecovery && !recoveryCode) {
      // Find the salt ID
      const saltId = await dbAdapter.getSaltId(decoded.sub!, audience);
      
      if (saltId) {
        newRecoveryCode = generateRecoveryCode();
        const recoveryCodeHash = hashRecoveryCode(newRecoveryCode);
        
        await dbAdapter.insertRecoveryCode(saltId, recoveryCodeHash);
      }
    }

    // Response
    const response: SaltResponse = { 
      salt,
      exp: decoded.exp,
      iat: decoded.iat
    };
    
    if (recoveryCode || newRecoveryCode) {
      response.recoveryCode = recoveryCode || newRecoveryCode;
      response.recoveryMessage = 'Store this recovery code safely. It cannot be retrieved later.';
    }
    
    res.json(response);
  } catch (error) {
    console.error('Salt generation error:', error);
    res.status(500).json({ 
      error: `Failed to generate salt: ${error instanceof Error ? error.message : 'Unknown error'}`
    });
  }
});

// API endpoint to recover salt using recovery code
app.post('/recover-salt', async (req: express.Request, res: express.Response) => {
  try {
    const { token, recoveryCode } = req.body;
    
    if (!token || !recoveryCode) {
      return res.status(400).json({ error: 'JWT token and recovery code are required' });
    }

    // Verify the JWT signature + iss/aud — recovery must not be possible
    // with a forged token plus a guessed/stolen recovery code.
    let decoded: JWTPayload;
    try {
      decoded = await verifyOAuthJwt(token);
    } catch (error) {
      return res.status(401).json({
        error: `JWT verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    }
    const audience = Array.isArray(decoded.aud) ? decoded.aud[0] : decoded.aud || '';
    
    if (!decoded.sub || !audience) {
      return res.status(400).json({ error: 'Invalid JWT: missing required claims' });
    }

    // Find salt ID
    const saltId = await dbAdapter.getSaltId(decoded.sub, audience);
    
    if (!saltId) {
      return res.status(404).json({ error: 'No salt found for this user' });
    }

    // Check recovery code
    const recoveryCodeHash = hashRecoveryCode(recoveryCode);
    const recoveryRow = await dbAdapter.getRecoveryCode(saltId, recoveryCodeHash);
    
    if (!recoveryRow) {
      return res.status(401).json({ error: 'Invalid or used recovery code' });
    }

    // Mark recovery code as used
    await dbAdapter.markRecoveryCodeUsed(recoveryRow.id);

    // Get and return the salt
    const { salt } = await getSalt(decoded.sub, audience);
    
    res.json({ 
      salt,
      message: 'Salt recovered successfully'
    });
  } catch (error) {
    console.error('Salt recovery error:', error);
    res.status(500).json({ 
      error: `Failed to recover salt: ${error instanceof Error ? error.message : 'Unknown error'}`
    });
  }
});

// Add endpoint to request a new recovery code
app.post('/generate-recovery-code', async (req: express.Request, res: express.Response) => {
  try {
    const { token } = req.body;
    
    if (!token) {
      return res.status(400).json({ error: 'JWT token is required' });
    }

    // Verify the JWT signature + iss/aud before minting a recovery code.
    let decoded: JWTPayload;
    try {
      decoded = await verifyOAuthJwt(token);
    } catch (error) {
      return res.status(401).json({
        error: `JWT verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      });
    }
    const audience = Array.isArray(decoded.aud) ? decoded.aud[0] : decoded.aud || '';
    
    if (!decoded.sub || !audience) {
      return res.status(400).json({ error: 'Invalid JWT: missing required claims' });
    }

    // Find salt ID
    const saltId = await dbAdapter.getSaltId(decoded.sub, audience);
    
    if (!saltId) {
      return res.status(404).json({ error: 'No salt found for this user' });
    }

    // Generate and store new recovery code
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = hashRecoveryCode(recoveryCode);
    
    await dbAdapter.insertRecoveryCode(saltId, recoveryCodeHash);
    
    res.json({ 
      recoveryCode,
      message: 'Store this recovery code safely. It cannot be retrieved later.'
    });
  } catch (error) {
    console.error('Recovery code generation error:', error);
    res.status(500).json({ 
      error: `Failed to generate recovery code: ${error instanceof Error ? error.message : 'Unknown error'}`
    });
  }
});

// Health check endpoint
app.get('/ping', (req: express.Request, res: express.Response) => {
  res.status(200).send('pong\n');
});

// Graceful shutdown handler
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  try {
    await dbAdapter.close();
    console.log('Database connection closed');
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

// Start the server after setup
if (require.main === module) {
  setup().then(() => {
    app.listen(PORT, () => {
      console.log(`Salt service running on port ${PORT}`);
    });
  }).catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

// Export for testing
export { app, setup, encrypt, decrypt, validateJwtClaims, verifyOAuthJwt, getAllowedAudiences, generateSecureRandomSalt, generateRecoveryCode, hashRecoveryCode };