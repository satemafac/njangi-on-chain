import { Pool } from 'pg';

// Use the same pool configuration as other database services
const DATABASE_URL = process.env.DATABASE_URL;
const useSSL = process.env.DATABASE_URL?.includes('amazonaws.com') || false;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined
});

export interface MainnetSignup {
  id: number;
  email: string;
  name?: string;
  user_address?: string;
  notification_preferences: {
    email: boolean;
    sms: boolean;
  };
  signup_source: string;
  created_at: Date;
  updated_at: Date;
}

export class MainnetSignupDatabase {
  // Create a new mainnet signup
  async createSignup(
    email: string,
    name?: string,
    userAddress?: string,
    notificationPreferences = { email: true, sms: false },
    signupSource = 'homepage'
  ): Promise<MainnetSignup | null> {
    try {
      console.log(`[DB] Creating mainnet signup: email=${email}, source=${signupSource}`);
      
      const result = await pool.query(
        `INSERT INTO mainnet_signups 
         (email, name, user_address, notification_preferences, signup_source) 
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) 
         DO UPDATE SET 
           name = COALESCE($2, mainnet_signups.name),
           user_address = COALESCE($3, mainnet_signups.user_address),
           notification_preferences = $4,
           signup_source = $5,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [email, name, userAddress, JSON.stringify(notificationPreferences), signupSource]
      );

      if (result.rows[0]) {
        console.log(`[DB] Successfully created/updated mainnet signup with ID: ${result.rows[0].id}`);
        // Parse the JSON notification preferences
        const signup = result.rows[0];
        signup.notification_preferences = JSON.parse(signup.notification_preferences);
        return signup as MainnetSignup;
      } else {
        console.log(`[DB] No rows returned after mainnet signup creation/update`);
      }

      return null;
    } catch (error) {
      console.error('[DB] Error creating mainnet signup:', error);
      return null;
    }
  }

  // Get all signups with pagination
  async getAllSignups(limit = 100, offset = 0): Promise<MainnetSignup[]> {
    try {
      console.log(`[DB] Fetching mainnet signups with limit: ${limit}, offset: ${offset}`);
      
      const result = await pool.query(
        `SELECT * FROM mainnet_signups 
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );

      console.log(`[DB] Found ${result.rows.length} mainnet signups`);
      
      // Parse JSON notification preferences for each signup
      return result.rows.map(row => ({
        ...row,
        notification_preferences: JSON.parse(row.notification_preferences)
      })) as MainnetSignup[];
    } catch (error) {
      console.error('[DB] Error getting mainnet signups:', error);
      return [];
    }
  }

  // Get signup count
  async getSignupCount(): Promise<number> {
    try {
      const result = await pool.query(
        `SELECT COUNT(*) as count FROM mainnet_signups`
      );

      return parseInt(result.rows[0].count) || 0;
    } catch (error) {
      console.error('[DB] Error getting signup count:', error);
      return 0;
    }
  }

  // Check if email already exists
  async emailExists(email: string): Promise<boolean> {
    try {
      const result = await pool.query(
        `SELECT id FROM mainnet_signups WHERE email = $1`,
        [email]
      );

      return result.rows.length > 0;
    } catch (error) {
      console.error('[DB] Error checking email existence:', error);
      return false;
    }
  }

  // Get signups by date range
  async getSignupsByDateRange(startDate: Date, endDate: Date): Promise<MainnetSignup[]> {
    try {
      const result = await pool.query(
        `SELECT * FROM mainnet_signups 
         WHERE created_at >= $1 AND created_at <= $2
         ORDER BY created_at DESC`,
        [startDate, endDate]
      );

      return result.rows.map(row => ({
        ...row,
        notification_preferences: JSON.parse(row.notification_preferences)
      })) as MainnetSignup[];
    } catch (error) {
      console.error('[DB] Error getting signups by date range:', error);
      return [];
    }
  }

  // Update notification preferences
  async updateNotificationPreferences(
    email: string,
    preferences: { email: boolean; sms: boolean }
  ): Promise<boolean> {
    try {
      const result = await pool.query(
        `UPDATE mainnet_signups 
         SET notification_preferences = $2, updated_at = CURRENT_TIMESTAMP
         WHERE email = $1`,
        [email, JSON.stringify(preferences)]
      );

      return result && result.rowCount ? result.rowCount > 0 : false;
    } catch (error) {
      console.error('[DB] Error updating notification preferences:', error);
      return false;
    }
  }
}

// Export a singleton instance
const mainnetSignupDatabase = new MainnetSignupDatabase();
export default mainnetSignupDatabase; 