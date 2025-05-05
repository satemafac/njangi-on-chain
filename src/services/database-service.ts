import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { JoinRequest } from './join-request-database';

// Define database path
const DB_PATH = path.join(process.cwd(), 'join-requests.db');

// Local interface for backward compatibility
interface LocalJoinRequest {
  id?: number;
  circleId: string;
  circleName: string;
  userAddress: string;
  userName: string;
  requestDate: number;
  status: 'pending' | 'approved' | 'rejected';
}

// Re-export the JoinRequest type
export { JoinRequest } from './join-request-database';

class DatabaseService {
  private db: Database.Database;

  constructor() {
    // Create database directory if it doesn't exist
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    // Initialize database
    this.db = new Database(DB_PATH);
    this.initializeDatabase();
  }

  private initializeDatabase() {
    // Enable foreign keys
    this.db.pragma('journal_mode = WAL');
    
    // Create join_requests table if it doesn't exist
    const createJoinRequestsTable = `
      CREATE TABLE IF NOT EXISTS join_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        circleId TEXT NOT NULL,
        circleName TEXT NOT NULL,
        userAddress TEXT NOT NULL,
        userName TEXT NOT NULL,
        requestDate INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
        UNIQUE(circleId, userAddress)
      )
    `;
    
    this.db.exec(createJoinRequestsTable);
    
    // Create index for faster queries
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_join_requests_circle_id ON join_requests(circleId)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_join_requests_status ON join_requests(status)`);
  }

  // Helper to convert from local format to database format
  private convertToDbFormat(request: LocalJoinRequest): JoinRequest {
    return {
      id: request.id || 0,
      circle_id: request.circleId,
      circle_name: request.circleName,
      user_address: request.userAddress,
      user_name: request.userName,
      status: request.status,
      created_at: new Date(request.requestDate),
      updated_at: new Date(request.requestDate)
    };
  }

  // Helper to convert from database format to local format
  private convertFromDbFormat(request: JoinRequest): LocalJoinRequest {
    return {
      id: request.id,
      circleId: request.circle_id,
      circleName: request.circle_name,
      userAddress: request.user_address,
      userName: request.user_name,
      requestDate: request.created_at.getTime(),
      status: request.status
    };
  }

  // Update create method to handle conversion
  createJoinRequest(request: LocalJoinRequest): LocalJoinRequest | null {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO join_requests (circleId, circleName, userAddress, userName, requestDate, status)
        VALUES (@circleId, @circleName, @userAddress, @userName, @requestDate, @status)
        ON CONFLICT(circleId, userAddress) 
        DO UPDATE SET status = @status, requestDate = @requestDate
      `);

      const result = stmt.run({
        circleId: request.circleId,
        circleName: request.circleName,
        userAddress: request.userAddress,
        userName: request.userName,
        requestDate: request.requestDate,
        status: request.status
      });

      if (result.changes > 0) {
        return {
          ...request,
          id: result.lastInsertRowid as number
        };
      }
      return null;
    } catch (error) {
      console.error('Error creating join request:', error);
      return null;
    }
  }

  // Get all pending requests for a circle
  getPendingRequestsByCircleId(circleId: string): JoinRequest[] {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM join_requests
        WHERE circleId = ? AND status = 'pending'
        ORDER BY requestDate DESC
      `);
      
      return stmt.all(circleId) as JoinRequest[];
    } catch (error) {
      console.error('Error getting pending requests:', error);
      return [];
    }
  }

  // Check if a user has a pending request for a circle
  userHasPendingRequest(circleId: string, userAddress: string): boolean {
    try {
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as count FROM join_requests
        WHERE circleId = ? AND userAddress = ? AND status = 'pending'
      `);
      
      const result = stmt.get(circleId, userAddress) as { count: number };
      return result.count > 0;
    } catch (error) {
      console.error('Error checking pending request:', error);
      return false;
    }
  }

  // Update join request status
  updateJoinRequestStatus(circleId: string, userAddress: string, status: 'approved' | 'rejected'): boolean {
    try {
      const stmt = this.db.prepare(`
        UPDATE join_requests
        SET status = ?
        WHERE circleId = ? AND userAddress = ? AND status = 'pending'
      `);
      
      const result = stmt.run(status, circleId, userAddress);
      return result.changes > 0;
    } catch (error) {
      console.error('Error updating join request status:', error);
      return false;
    }
  }

  // Get all requests for a user
  getRequestsByUserAddress(userAddress: string): JoinRequest[] {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM join_requests
        WHERE userAddress = ?
        ORDER BY requestDate DESC
      `);
      
      return stmt.all(userAddress) as JoinRequest[];
    } catch (error) {
      console.error('Error getting user requests:', error);
      return [];
    }
  }
}

// Create a singleton instance
const databaseService = new DatabaseService();
export default databaseService; 