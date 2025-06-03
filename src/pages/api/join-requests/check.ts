import type { NextApiRequest, NextApiResponse } from 'next';
import joinRequestDatabase from '../../../services/join-request-database';
import databaseService from '../../../services/database-service';

type ResponseData = {
  success: boolean;
  message?: string;
  data?: {
    hasPendingRequest: boolean;
  };
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
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { circleId, userAddress } = req.query;

    // Validate required fields
    if (!circleId || !userAddress || typeof circleId !== 'string' || typeof userAddress !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Missing required query parameters: circleId and userAddress'
      });
    }

    console.log(`[DEBUG] Checking pending request for circle: ${circleId}, user: ${userAddress}`);
    console.log(`[DEBUG] Is localhost: ${isLocalhost()}`);

    let hasPendingRequest = false;

    if (isLocalhost()) {
      // Use local SQLite database service for localhost
      console.log('[DEBUG] Using local SQLite database service');
      try {
        hasPendingRequest = databaseService.userHasPendingRequest(circleId, userAddress);
        console.log(`[DEBUG] SQLite pending request check result: ${hasPendingRequest}`);
      } catch (sqliteError) {
        console.error('[DEBUG] SQLite database error:', sqliteError);
        hasPendingRequest = false;
      }
    } else {
      // Use PostgreSQL database for production
      console.log('[DEBUG] Using PostgreSQL database for production');
      try {
        hasPendingRequest = await joinRequestDatabase.checkPendingRequest(circleId, userAddress);
      } catch (dbError) {
        console.error('[DEBUG] PostgreSQL database error:', dbError);
        hasPendingRequest = false;
      }
    }
    
    console.log(`[DEBUG] Final pending request check result: ${hasPendingRequest}`);

    return res.status(200).json({
      success: true,
      data: { hasPendingRequest }
    });
  } catch (error) {
    console.error('Error checking pending request:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to check pending request status'
    });
  }
} 