/**
 * Database check utility for zkLogin salt database
 * 
 * This script checks the salt database and logs its contents
 * to help debug zkLogin verification issues.
 */

/* eslint-disable */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Constants
const PROJECT_ROOT = path.resolve(__dirname);
const DB_PATH = path.join(PROJECT_ROOT, 'salt-database.db');

console.log(`Checking database at: ${DB_PATH}`);

// Check if database exists
if (!fs.existsSync(DB_PATH)) {
  console.error(`Database file not found at ${DB_PATH}`);
  process.exit(1);
}

try {
  // Open database
  const db = new Database(DB_PATH, { verbose: console.log });
  console.log('Database opened successfully');

  // Get database info
  const dbInfo = db.pragma('database_list');
  console.log('Database info:', dbInfo);

  // Check tables
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('Tables in database:', tables.map(t => t.name));

  // Check salt table
  if (tables.some(t => t.name === 'salts')) {
    const saltCount = db.prepare('SELECT COUNT(*) as count FROM salts').get();
    console.log(`Salt table contains ${saltCount.count} records`);

    if (saltCount.count > 0) {
      // Get sample of salts (without showing the actual encrypted salt)
      const salts = db.prepare(`
        SELECT 
          id, 
          sub, 
          aud, 
          length(salt_encrypted) as salt_length,
          created_at, 
          updated_at 
        FROM salts 
        ORDER BY id DESC 
        LIMIT 10
      `).all();
      
      console.log('Recent salts:', salts);
    }
  } else {
    console.log('Salt table not found in database');
  }

  // Check recovery codes table
  if (tables.some(t => t.name === 'recovery_codes')) {
    const codeCount = db.prepare('SELECT COUNT(*) as count FROM recovery_codes').get();
    console.log(`Recovery codes table contains ${codeCount.count} records`);

    if (codeCount.count > 0) {
      const unusedCount = db.prepare('SELECT COUNT(*) as count FROM recovery_codes WHERE used_at IS NULL').get();
      console.log(`Unused recovery codes: ${unusedCount.count}`);
    }
  } else {
    console.log('Recovery codes table not found in database');
  }

  // Close database
  db.close();
  console.log('Database check completed');

} catch (error) {
  console.error('Error checking database:', error);
  process.exit(1);
}
