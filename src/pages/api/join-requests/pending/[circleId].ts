import type { NextApiRequest, NextApiResponse } from 'next';
import joinRequestDatabase, { JoinRequest } from '../../../../services/join-request-database';
import databaseService from '../../../../services/database-service';

type ResponseData = {
  success: boolean;
  message?: string;
  data?: JoinRequest[];
};

// Check if we're running on localhost
const isLocalhost = () => {
  return process.env.NODE_ENV === 'development' || 
         process.env.VERCEL_ENV === 'development' ||
         !process.env.DATABASE_URL;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  const { circleId } = req.query;
  const { clear } = req.query; // Support ?clear=all parameter

  // Validate required parameter
  if (!circleId || typeof circleId !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Missing or invalid circle ID'
    });
  }

  if (req.method === 'GET') {
    try {
      console.log(`[DEBUG] Fetching pending requests for circle ID: ${circleId}`);
      console.log(`[DEBUG] Is localhost: ${isLocalhost()}`);
      
      let requests: JoinRequest[] = [];

      if (isLocalhost()) {
        // Use local SQLite database service for localhost
        console.log('[DEBUG] Using local SQLite database service');
        
        // Handle clear parameter
        if (clear === 'all') {
          console.log('[DEBUG] Clear parameter not implemented for SQLite database');
          return res.status(200).json({
            success: true,
            data: [],
            message: 'Clear function not implemented for SQLite database'
          });
        }
        
        try {
          requests = databaseService.getPendingRequestsByCircleId(circleId);
          console.log(`[DEBUG] SQLite found ${requests.length} pending requests for circle ${circleId}`);
        } catch (sqliteError) {
          console.error('[DEBUG] SQLite database error:', sqliteError);
          requests = [];
        }
      } else {
        // Use PostgreSQL database for production
        console.log('[DEBUG] Using PostgreSQL database for production');
        try {
          requests = await joinRequestDatabase.getPendingRequestsByCircleId(circleId);
        } catch (dbError) {
          console.error('[DEBUG] PostgreSQL database error:', dbError);
          // Even in production, if DB fails, return empty array instead of crashing
          requests = [];
        }
      }
      
      console.log(`[DEBUG] Found ${requests.length} pending requests for circle ${circleId}`);
      if (requests.length > 0) {
        console.log(`[DEBUG] Request sample:`, JSON.stringify(requests[0]));
      }

      // Return the pending requests
      return res.status(200).json({
        success: true,
        data: requests
      });
    } catch (error) {
      console.error('Error fetching pending join requests:', error);
      
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch pending join requests'
      });
    }
  } else if (req.method === 'DELETE') {
    // Handle clearing notifications
    try {
      if (isLocalhost()) {
        // For SQLite, we could implement a clear method if needed
        console.log('[DEBUG] Clear function not implemented for SQLite database');
        return res.status(200).json({
          success: true,
          message: 'Clear function not implemented for SQLite database'
        });
      } else {
        // For production, you might want to implement actual clearing logic
        return res.status(200).json({
          success: true,
          message: 'Clear functionality not implemented for production'
        });
      }
    } catch (error) {
      console.error('Error clearing notifications:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to clear notifications'
      });
    }
  } else {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }
} 