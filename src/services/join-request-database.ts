import { Pool } from 'pg';

// Use the same pool configuration as postgres-adapter.ts
const DATABASE_URL = process.env.DATABASE_URL;
const useSSL = process.env.DATABASE_URL?.includes('amazonaws.com') || false;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : undefined
});

export interface JoinRequest {
  id: number;
  circle_id: string;
  circle_name: string;
  user_address: string;
  user_name: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: Date;
  updated_at: Date;
}

export class JoinRequestDatabase {
  // Create a new join request
  async createJoinRequest(
    circleId: string,
    circleName: string,
    userAddress: string,
    userName: string,
    status: 'pending' | 'approved' | 'rejected' = 'pending'
  ): Promise<JoinRequest | null> {
    try {
      console.log(`[DB] Creating join request: circle=${circleId}, user=${userAddress}, status=${status}`);
      
      const result = await pool.query(
        `INSERT INTO join_requests 
         (circle_id, circle_name, user_address, user_name, status) 
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (circle_id, user_address) 
         DO UPDATE SET 
           circle_name = $2, 
           user_name = $4,
           status = $5,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [circleId, circleName, userAddress, userName, status]
      );

      if (result.rows[0]) {
        console.log(`[DB] Successfully created/updated join request with ID: ${result.rows[0].id}`);
      } else {
        console.log(`[DB] No rows returned after join request creation/update`);
      }

      return result.rows[0] as JoinRequest;
    } catch (error) {
      console.error('[DB] Error creating join request:', error);
      return null;
    }
  }

  // Get all pending requests for a circle
  async getPendingRequestsByCircleId(circleId: string): Promise<JoinRequest[]> {
    try {
      console.log(`[DB] Fetching pending requests for circle: ${circleId}`);
      
      const result = await pool.query(
        `SELECT * FROM join_requests 
         WHERE circle_id = $1 AND status = 'pending'
         ORDER BY created_at DESC`,
        [circleId]
      );

      console.log(`[DB] Found ${result.rows.length} pending requests for circle: ${circleId}`);
      
      return result.rows as JoinRequest[];
    } catch (error) {
      console.error('[DB] Error getting pending requests:', error);
      return [];
    }
  }

  // Check if a user has a pending request for a circle
  async checkPendingRequest(circleId: string, userAddress: string): Promise<boolean> {
    try {
      console.log(`[DB] Checking pending request for circle: ${circleId}, user: ${userAddress}`);
      
      const result = await pool.query(
        `SELECT id FROM join_requests 
         WHERE circle_id = $1 AND user_address = $2 AND status = 'pending'`,
        [circleId, userAddress]
      );

      const hasPending = result.rows.length > 0;
      console.log(`[DB] Pending request check result for ${userAddress}: ${hasPending}`);
      
      return hasPending;
    } catch (error) {
      console.error('[DB] Error checking pending request:', error);
      return false;
    }
  }

  // Update join request status (approve/reject)
  async updateJoinRequestStatus(
    circleId: string,
    userAddress: string,
    status: 'approved' | 'rejected'
  ): Promise<boolean> {
    try {
      const result = await pool.query(
        `UPDATE join_requests 
         SET status = $3, updated_at = CURRENT_TIMESTAMP
         WHERE circle_id = $1 AND user_address = $2`,
        [circleId, userAddress, status]
      );

      return result && result.rowCount ? result.rowCount > 0 : false;
    } catch (error) {
      console.error('Error updating join request status:', error);
      return false;
    }
  }

  // Get all requests for a user
  async getRequestsByUserAddress(userAddress: string): Promise<JoinRequest[]> {
    try {
      const result = await pool.query(
        `SELECT * FROM join_requests 
         WHERE user_address = $1
         ORDER BY updated_at DESC`,
        [userAddress]
      );

      return result.rows as JoinRequest[];
    } catch (error) {
      console.error('Error getting user requests:', error);
      return [];
    }
  }

  // Get all requests for a circle
  async getRequestsByCircleId(circleId: string): Promise<JoinRequest[]> {
    try {
      const result = await pool.query(
        `SELECT * FROM join_requests 
         WHERE circle_id = $1
         ORDER BY updated_at DESC`,
        [circleId]
      );

      return result.rows as JoinRequest[];
    } catch (error) {
      console.error('Error getting circle requests:', error);
      return [];
    }
  }
}

// Create a singleton instance for easy import
const joinRequestDatabase = new JoinRequestDatabase();
export default joinRequestDatabase; 