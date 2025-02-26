/**
 * A production-ready salt service that manages user-specific salts.
 * 
 * This service generates, encrypts, and stores salts in a local SQLite database
 * with recovery mechanisms, following Sui zkLogin best practices.
 */

'use strict';

import express from 'express';
import cors from 'cors';
import { decodeJwt, JWTPayload } from 'jose';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import Database from 'better-sqlite3';
import { promises as fs } from 'fs';

// Constants
const PORT = 5002;
const MAX_SALT = 2n ** 128n - 1n; // Maximum allowed salt value
const ENCRYPTION_KEY_PATH = './.encryption-key';
const DB_PATH = './salt-database.db';
const ALGORITHM = 'aes-256-gcm';

// Define response type for salt requests
interface SaltResponse {
  salt: string;
  exp?: number;
  iat?: number;
  recoveryCode?: string;
  recoveryMessage?: string;
  message?: string;
}

// Database row types
interface SaltRow {
  id: number;
  salt_encrypted: Buffer;
  iv: Buffer;
  tag: Buffer;
}

interface RecoveryRow {
  id: number;
}

// Initialize app
const app = express();

// Parse JSON requests
app.use(express.json());

// Enable CORS for development
app.use(cors());

// Database and encryption setup
let encryptionKey: Buffer;
let db: Database.Database;

async function setup() {
  try {
    // Create encryption key if it doesn't exist
    try {
      encryptionKey = await fs.readFile(ENCRYPTION_KEY_PATH);
    } catch {
      // Generate and save a new encryption key
      encryptionKey = randomBytes(32); // 256 bits
      await fs.writeFile(ENCRYPTION_KEY_PATH, encryptionKey);
      console.log('Generated new encryption key');
    }

    // Initialize database
    db = new Database(DB_PATH);
    
    // Create tables if they don't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS salts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sub TEXT NOT NULL,
        aud TEXT NOT NULL,
        salt_encrypted BLOB NOT NULL,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(sub, aud)
      );
      
      CREATE TABLE IF NOT EXISTS recovery_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        salt_id INTEGER NOT NULL,
        code_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        used_at TIMESTAMP,
        FOREIGN KEY (salt_id) REFERENCES salts(id)
      );
    `);

    console.log('Database initialized');
  } catch (error) {
    console.error('Setup error:', error);
    process.exit(1);
  }
}

// Encrypt data using AES-256-GCM
function encrypt(data: string): { encrypted: Buffer, iv: Buffer, tag: Buffer } {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, encryptionKey, iv, { authTagLength: 16 });
  
  const encrypted = Buffer.concat([
    cipher.update(data, 'utf8'),
    cipher.final()
  ]);
  
  const tag = cipher.getAuthTag();
  
  return { encrypted, iv, tag };
}

// Decrypt data
function decrypt(encrypted: Buffer, iv: Buffer, tag: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, encryptionKey, iv, { authTagLength: 16 });
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
async function getSalt(sub: string, aud: string): Promise<string> {
  try {
    // Check if we already have a salt for this user
    const stmt = db.prepare('SELECT id, salt_encrypted, iv, tag FROM salts WHERE sub = ? AND aud = ?');
    const row = stmt.get(sub, aud) as SaltRow | undefined;
    
    if (row) {
      // Decrypt the existing salt
      try {
        const salt = decrypt(
          Buffer.from(row.salt_encrypted),
          Buffer.from(row.iv),
          Buffer.from(row.tag)
        );
        
        return salt;
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
    const insertStmt = db.prepare(
      'INSERT INTO salts (sub, aud, salt_encrypted, iv, tag) VALUES (?, ?, ?, ?, ?)'
    );
    
    const result = insertStmt.run(
      sub, 
      aud, 
      encrypted, 
      iv, 
      tag
    );
    
    if (!result.lastInsertRowid) {
      throw new Error('Failed to store salt');
    }
    
    // Generate recovery code
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = hashRecoveryCode(recoveryCode);
    
    // Store recovery code hash
    const recoveryStmt = db.prepare(
      'INSERT INTO recovery_codes (salt_id, code_hash) VALUES (?, ?)'
    );
    
    recoveryStmt.run(result.lastInsertRowid, recoveryCodeHash);
    
    // Return the new salt and recovery code
    return newSalt;
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

    // Get or create salt
    const salt = await getSalt(decoded.sub!, audience);
    
    // Generate new recovery code if requested
    const generateRecovery = req.body.generateRecovery === true;
    let recoveryCode = null;
    
    if (generateRecovery) {
      // Find the salt ID
      const saltRow = db.prepare('SELECT id FROM salts WHERE sub = ? AND aud = ?').get(decoded.sub!, audience) as { id: number } | undefined;
      
      if (saltRow) {
        recoveryCode = generateRecoveryCode();
        const recoveryCodeHash = hashRecoveryCode(recoveryCode);
        
        db.prepare('INSERT INTO recovery_codes (salt_id, code_hash) VALUES (?, ?)')
          .run(saltRow.id, recoveryCodeHash);
      }
    }

    // Response
    const response: SaltResponse = { 
      salt,
      exp: decoded.exp,
      iat: decoded.iat
    };
    
    if (recoveryCode) {
      response.recoveryCode = recoveryCode;
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

    // Decode JWT to get sub and aud
    const decoded = decodeJwt(token);
    const audience = Array.isArray(decoded.aud) ? decoded.aud[0] : decoded.aud || '';
    
    if (!decoded.sub || !audience) {
      return res.status(400).json({ error: 'Invalid JWT: missing required claims' });
    }

    // Find salt ID
    const saltRow = db.prepare('SELECT id FROM salts WHERE sub = ? AND aud = ?').get(decoded.sub, audience) as { id: number } | undefined;
    
    if (!saltRow) {
      return res.status(404).json({ error: 'No salt found for this user' });
    }

    // Check recovery code
    const recoveryCodeHash = hashRecoveryCode(recoveryCode);
    const recoveryRow = db.prepare(
      'SELECT id FROM recovery_codes WHERE salt_id = ? AND code_hash = ? AND used_at IS NULL'
    ).get(saltRow.id, recoveryCodeHash) as RecoveryRow | undefined;
    
    if (!recoveryRow) {
      return res.status(401).json({ error: 'Invalid or used recovery code' });
    }

    // Mark recovery code as used
    db.prepare(
      'UPDATE recovery_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).run(recoveryRow.id);

    // Get and return the salt
    const salt = await getSalt(decoded.sub, audience);
    
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

    // Decode JWT to get sub and aud
    const decoded = decodeJwt(token);
    const audience = Array.isArray(decoded.aud) ? decoded.aud[0] : decoded.aud || '';
    
    if (!decoded.sub || !audience) {
      return res.status(400).json({ error: 'Invalid JWT: missing required claims' });
    }

    // Find salt ID
    const saltRow = db.prepare('SELECT id FROM salts WHERE sub = ? AND aud = ?').get(decoded.sub, audience) as { id: number } | undefined;
    
    if (!saltRow) {
      return res.status(404).json({ error: 'No salt found for this user' });
    }

    // Generate and store new recovery code
    const recoveryCode = generateRecoveryCode();
    const recoveryCodeHash = hashRecoveryCode(recoveryCode);
    
    db.prepare('INSERT INTO recovery_codes (salt_id, code_hash) VALUES (?, ?)')
      .run(saltRow.id, recoveryCodeHash);
    
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

// Start the server after setup
setup().then(() => {
  app.listen(PORT, () => {
    console.log(`Salt service running on http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
}); 