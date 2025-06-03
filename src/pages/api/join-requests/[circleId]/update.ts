import type { NextApiRequest, NextApiResponse } from 'next';
import joinRequestDatabase from '../../../../services/join-request-database';
import databaseService from '../../../../services/database-service';

type ResponseData = {
  success: boolean;
  message?: string;
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
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { circleId } = req.query;
    const { userAddress, status } = req.body;

    // Validate required fields
    if (!circleId || typeof circleId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid circle ID'
      });
    }

    if (!userAddress || typeof userAddress !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid user address'
      });
    }

    if (!status || (status !== 'approved' && status !== 'rejected')) {
      return res.status(400).json({
        success: false,
        message: 'Status must be either "approved" or "rejected"'
      });
    }

    console.log(`[API] Updating join request for circle ${circleId}, user ${userAddress} to status ${status}`);
    console.log(`[API] Is localhost: ${isLocalhost()}`);

    let success = false;

    if (isLocalhost()) {
      // Use local SQLite database service for localhost
      console.log('[API] Using local SQLite database service');
      try {
        success = databaseService.updateJoinRequestStatus(circleId, userAddress, status);
        console.log(`[API] SQLite update result: ${success}`);
      } catch (sqliteError) {
        console.error('[API] SQLite database error:', sqliteError);
        return res.status(500).json({
          success: false,
          message: 'Local database error: ' + (sqliteError as Error).message
        });
      }
    } else {
      // Use PostgreSQL database for production
      console.log('[API] Using PostgreSQL database for production');
      try {
        success = await joinRequestDatabase.updateJoinRequestStatus(
          circleId,
          userAddress,
          status
        );
      } catch (dbError) {
        console.error('[API] PostgreSQL database error:', dbError);
        return res.status(500).json({
          success: false,
          message: 'Database connection failed'
        });
      }
    }

    if (!success) {
      console.log(`[API] Failed to update join request status in database`);
      return res.status(500).json({
        success: false,
        message: 'Failed to update join request status'
      });
    }

    console.log(`[API] Successfully updated join request status to ${status}`);
    return res.status(200).json({
      success: true
    });
  } catch (error) {
    console.error('Error updating join request:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update join request: ' + (error as Error).message
    });
  }
} 