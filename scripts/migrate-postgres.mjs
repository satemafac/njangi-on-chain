import pg from 'pg';
const { Pool } = pg;

// Get database connection from environment variables
const DATABASE_URL = process.env.DATABASE_URL;
const useSSL = process.env.DATABASE_URL?.includes('amazonaws.com') || false;

if (!DATABASE_URL) {
  console.error('Error: DATABASE_URL environment variable is not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined
});

async function createTables() {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Create join_requests table
    await client.query(`
      CREATE TABLE IF NOT EXISTS join_requests (
        id SERIAL PRIMARY KEY,
        circle_id TEXT NOT NULL,
        circle_name TEXT NOT NULL,
        user_address TEXT NOT NULL,
        user_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(circle_id, user_address)
      )
    `);
    
    // Create indexes for faster queries
    await client.query(`CREATE INDEX IF NOT EXISTS idx_join_requests_circle_id ON join_requests(circle_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_join_requests_user_address ON join_requests(user_address)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_join_requests_status ON join_requests(status)`);
    
    await client.query('COMMIT');
    console.log('✅ Database schema created successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error creating database schema:', error);
    throw error;
  } finally {
    client.release();
  }
}

// Run the migration
createTables()
  .then(() => {
    console.log('Migration completed successfully');
    process.exit(0);
  })
  .catch(error => {
    console.error('Migration failed:', error);
    process.exit(1);
  }); 