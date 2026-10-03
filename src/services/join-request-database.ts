import type { Pool } from 'pg';
import { getSharedPgPool } from '../lib/pg-pool';

// Shared lazy pool (SSL resolved from sslmode/PGSSLMODE, verified TLS by
// default in production) — see src/lib/pg-pool.ts.
function pool(): Pool {
  return getSharedPgPool();
}

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

// Reads THROW when the table can't be read. `[]`, `false` and `null` mean the
// table really holds no such row, so a caller can't mistake a Postgres outage
// for an empty queue or for "no request yet" (it used to read as both).
export class JoinRequestDatabase {
  // Create (or refresh) a join request. Throws when the write fails, so the
  // route answers an error instead of reporting an unsaved request as sent.
  async createJoinRequest(
    circleId: string,
    circleName: string,
    userAddress: string,
    userName: string,
    status: 'pending' | 'approved' | 'rejected' = 'pending'
  ): Promise<JoinRequest> {
    try {
      console.log(`[DB] Creating join request: circle=${circleId}, user=${userAddress}, status=${status}`);
      
      const result = await pool().query(
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

      const row = result.rows[0] as JoinRequest | undefined;
      if (!row) {
        throw new Error('Saving the join request returned no row');
      }
      console.log(`[DB] Successfully created/updated join request with ID: ${row.id}`);
      return row;
    } catch (error) {
      console.error('[DB] Error creating join request:', error);
      throw error;
    }
  }

  // Get all pending requests for a circle. Throws when the read fails.
  async getPendingRequestsByCircleId(circleId: string): Promise<JoinRequest[]> {
    try {
      console.log(`[DB] Fetching pending requests for circle: ${circleId}`);
      
      const result = await pool().query(
        `SELECT * FROM join_requests 
         WHERE circle_id = $1 AND status = 'pending'
         ORDER BY created_at DESC`,
        [circleId]
      );

      console.log(`[DB] Found ${result.rows.length} pending requests for circle: ${circleId}`);
      
      return result.rows as JoinRequest[];
    } catch (error) {
      console.error('[DB] Error getting pending requests:', error);
      throw error;
    }
  }

  // Check if a user has a pending request for a circle. Throws when the read fails.
  async checkPendingRequest(circleId: string, userAddress: string): Promise<boolean> {
    try {
      console.log(`[DB] Checking pending request for circle: ${circleId}, user: ${userAddress}`);
      
      const result = await pool().query(
        `SELECT id FROM join_requests 
         WHERE circle_id = $1 AND user_address = $2 AND status = 'pending'`,
        [circleId, userAddress]
      );

      const hasPending = result.rows.length > 0;
      console.log(`[DB] Pending request check result for ${userAddress}: ${hasPending}`);
      
      return hasPending;
    } catch (error) {
      console.error('[DB] Error checking pending request:', error);
      throw error;
    }
  }

  // Update join request status (approve/reject). False when the write fails or
  // matches no row; the route answers 500 for both.
  async updateJoinRequestStatus(
    circleId: string,
    userAddress: string,
    status: 'approved' | 'rejected'
  ): Promise<boolean> {
    try {
      const result = await pool().query(
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

  // Get user info by address for a specific circle
  // Returns the most recent request (any status) for this user/circle combination,
  // or null when there is none. Throws when the read fails.
  async getUserByAddress(circleId: string, userAddress: string): Promise<JoinRequest | null> {
    try {
      console.log(`[DB] Looking up user: ${userAddress} for circle: ${circleId}`);
      
      const result = await pool().query(
        `SELECT * FROM join_requests 
         WHERE circle_id = $1 AND user_address = $2
         ORDER BY updated_at DESC
         LIMIT 1`,
        [circleId, userAddress]
      );

      if (result.rows.length > 0) {
        console.log(`[DB] Found user: ${result.rows[0].user_name}`);
        return result.rows[0] as JoinRequest;
      }

      console.log(`[DB] No user found for address: ${userAddress}`);
      return null;
    } catch (error) {
      console.error('[DB] Error looking up user by address:', error);
      throw error;
    }
  }
}

// Create a singleton instance for easy import
const joinRequestDatabase = new JoinRequestDatabase();
export default joinRequestDatabase; 