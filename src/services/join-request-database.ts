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
    userName: string
  ): Promise<JoinRequest | null> {
    try {
      const result = await pool.query(
        `INSERT INTO join_requests 
         (circle_id, circle_name, user_address, user_name) 
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (circle_id, user_address) 
         DO UPDATE SET 
           circle_name = $2, 
           user_name = $4,
           status = 'pending',
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [circleId, circleName, userAddress, userName]
      );

      return result.rows[0] as JoinRequest;
    } catch (error) {
      console.error('Error creating join request:', error);
      return null;
    }
  }

  // Get all pending requests for a circle
  async getPendingRequestsByCircleId(circleId: string): Promise<JoinRequest[]> {
    try {
      const result = await pool.query(
        `SELECT * FROM join_requests 
         WHERE circle_id = $1 AND status = 'pending'
         ORDER BY created_at DESC`,
        [circleId]
      );

      return result.rows as JoinRequest[];
    } catch (error) {
      console.error('Error getting pending requests:', error);
      return [];
    }
  }

  // Check if a user has a pending request for a circle
  async checkPendingRequest(circleId: string, userAddress: string): Promise<boolean> {
    try {
      const result = await pool.query(
        `SELECT id FROM join_requests 
         WHERE circle_id = $1 AND user_address = $2 AND status = 'pending'`,
        [circleId, userAddress]
      );

      return result.rows.length > 0;
    } catch (error) {
      console.error('Error checking pending request:', error);
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

      return result.rowCount > 0;
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