/**
 * PostgreSQL adapter for the salt service.
 * This adapter is used in production environments (e.g., Heroku).
 */

import { Pool } from 'pg';

// Define environment variable for DATABASE_URL
const DATABASE_URL = process.env.DATABASE_URL;

// Check if we're using SSL (Heroku PostgreSQL requires SSL)
const useSSL = process.env.DATABASE_URL?.includes('amazonaws.com') || false;

// Create a PostgreSQL connection pool
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined
});

export interface SaltData {
  id?: number;
  salt_encrypted?: Buffer;
  iv?: Buffer;
  tag?: Buffer;
  salt?: string;
}

export interface DatabaseAdapter {
  setup(): Promise<void>;
  getSalt(sub: string, aud: string): Promise<SaltData>;
  insertSalt(sub: string, aud: string, saltEncrypted: Buffer, iv: Buffer, tag: Buffer): Promise<number>;
  insertRecoveryCode(saltId: number, codeHash: string): Promise<void>;
  getSaltId(sub: string, aud: string): Promise<number | null>;
  getRecoveryCode(saltId: number, codeHash: string): Promise<{ id: number } | null>;
  markRecoveryCodeUsed(id: number): Promise<void>;
  close(): Promise<void>;
}

export class PostgresAdapter implements DatabaseAdapter {
  async setup(): Promise<void> {
    try {
      // Create tables if they don't exist
      await pool.query(`
        CREATE TABLE IF NOT EXISTS salts (
          id SERIAL PRIMARY KEY,
          sub TEXT NOT NULL,
          aud TEXT NOT NULL,
          salt_encrypted BYTEA NOT NULL,
          iv BYTEA NOT NULL,
          tag BYTEA NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(sub, aud)
        );
        
        CREATE TABLE IF NOT EXISTS recovery_codes (
          id SERIAL PRIMARY KEY,
          salt_id INTEGER NOT NULL,
          code_hash TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          used_at TIMESTAMP,
          CONSTRAINT fk_salt
            FOREIGN KEY(salt_id) 
            REFERENCES salts(id)
        );

        CREATE TABLE IF NOT EXISTS join_requests (
          id SERIAL PRIMARY KEY,
          circle_id TEXT NOT NULL,
          circle_name TEXT NOT NULL,
          user_address TEXT NOT NULL,
          user_name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(circle_id, user_address)
        );
      `);

      console.log('PostgreSQL database initialized');
    } catch (error) {
      console.error('PostgreSQL setup error:', error);
      throw error;
    }
  }

  async getSalt(sub: string, aud: string): Promise<SaltData> {
    const result = await pool.query(
      'SELECT id, salt_encrypted, iv, tag FROM salts WHERE sub = $1 AND aud = $2',
      [sub, aud]
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      return {
        id: row.id,
        salt_encrypted: row.salt_encrypted,
        iv: row.iv,
        tag: row.tag
      };
    }

    return {};
  }

  async insertSalt(sub: string, aud: string, saltEncrypted: Buffer, iv: Buffer, tag: Buffer): Promise<number> {
    const result = await pool.query(
      'INSERT INTO salts (sub, aud, salt_encrypted, iv, tag) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [sub, aud, saltEncrypted, iv, tag]
    );

    return result.rows[0].id;
  }

  async insertRecoveryCode(saltId: number, codeHash: string): Promise<void> {
    await pool.query(
      'INSERT INTO recovery_codes (salt_id, code_hash) VALUES ($1, $2)',
      [saltId, codeHash]
    );
  }

  async getSaltId(sub: string, aud: string): Promise<number | null> {
    const result = await pool.query(
      'SELECT id FROM salts WHERE sub = $1 AND aud = $2',
      [sub, aud]
    );

    if (result.rows.length > 0) {
      return result.rows[0].id;
    }

    return null;
  }

  async getRecoveryCode(saltId: number, codeHash: string): Promise<{ id: number } | null> {
    const result = await pool.query(
      'SELECT id FROM recovery_codes WHERE salt_id = $1 AND code_hash = $2 AND used_at IS NULL',
      [saltId, codeHash]
    );

    if (result.rows.length > 0) {
      return { id: result.rows[0].id };
    }

    return null;
  }

  async markRecoveryCodeUsed(id: number): Promise<void> {
    await pool.query(
      'UPDATE recovery_codes SET used_at = CURRENT_TIMESTAMP WHERE id = $1',
      [id]
    );
  }

  async close(): Promise<void> {
    await pool.end();
  }
}

// Define interfaces for SQLite types to avoid using 'any'
interface SQLiteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { lastInsertRowid: number | bigint };
}

interface SQLiteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SQLiteStatement;
  close(): void;
}

// SQLite adapter with more specific type definitions
export class SQLiteAdapter implements DatabaseAdapter {
  private db: SQLiteDatabase;
  private DB_PATH: string;

  constructor(dbPath: string, Database: new (path: string) => SQLiteDatabase) {
    this.DB_PATH = dbPath;
    this.db = new Database(this.DB_PATH);
  }

  async setup(): Promise<void> {
    // Create tables if they don't exist
    this.db.exec(`
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

    console.log('SQLite database initialized');
  }

  async getSalt(sub: string, aud: string): Promise<SaltData> {
    const stmt = this.db.prepare('SELECT id, salt_encrypted, iv, tag FROM salts WHERE sub = ? AND aud = ?');
    const row = stmt.get(sub, aud) as SaltData | undefined;
    return row || {};
  }

  async insertSalt(sub: string, aud: string, saltEncrypted: Buffer, iv: Buffer, tag: Buffer): Promise<number> {
    const stmt = this.db.prepare(
      'INSERT INTO salts (sub, aud, salt_encrypted, iv, tag) VALUES (?, ?, ?, ?, ?)'
    );
    
    const result = stmt.run(sub, aud, saltEncrypted, iv, tag);
    return Number(result.lastInsertRowid);
  }

  async insertRecoveryCode(saltId: number, codeHash: string): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT INTO recovery_codes (salt_id, code_hash) VALUES (?, ?)'
    );
    
    stmt.run(saltId, codeHash);
  }

  async getSaltId(sub: string, aud: string): Promise<number | null> {
    const stmt = this.db.prepare('SELECT id FROM salts WHERE sub = ? AND aud = ?');
    const row = stmt.get(sub, aud) as { id: number } | undefined;
    
    return row ? row.id : null;
  }

  async getRecoveryCode(saltId: number, codeHash: string): Promise<{ id: number } | null> {
    const stmt = this.db.prepare(
      'SELECT id FROM recovery_codes WHERE salt_id = ? AND code_hash = ? AND used_at IS NULL'
    );
    
    const row = stmt.get(saltId, codeHash) as { id: number } | undefined;
    return row || null;
  }

  async markRecoveryCodeUsed(id: number): Promise<void> {
    const stmt = this.db.prepare(
      'UPDATE recovery_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?'
    );
    
    stmt.run(id);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// Factory function to get the appropriate database adapter
export async function getDatabaseAdapter(): Promise<DatabaseAdapter> {
  if (process.env.USE_POSTGRES === 'true') {
    console.log('Using PostgreSQL adapter');
    return new PostgresAdapter();
  } else {
    console.log('Using SQLite adapter');
    try {
      // Use dynamic import for better-sqlite3
      // This avoids ESM/CJS interop issues while still following ESM standards
      const BetterSqlite3 = await import('better-sqlite3');
      const Database = BetterSqlite3.default;
      
      return new SQLiteAdapter('./salt-database.db', Database);
    } catch (error) {
      console.error('Failed to load SQLite adapter:', error);
      throw new Error('SQLite adapter failed to initialize');
    }
  }
} 