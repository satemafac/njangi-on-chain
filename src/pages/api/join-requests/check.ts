import type { NextApiRequest, NextApiResponse } from 'next';
import joinRequestDatabase from '../../../services/join-request-database';
import databaseService from '../../../services/database-service';
import { requireSessionAddress, sendJoinRequestAuthFailure } from '../../../lib/join-request-auth';
import { sendJoinRequestReadFailure } from '../../../lib/join-request-read-failure';

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

    // Members may only ask about their own request.
    const auth = await requireSessionAddress(req, userAddress);
    if (!auth.ok) {
      return sendJoinRequestAuthFailure(res, auth);
    }

    console.log(`[DEBUG] Checking pending request for circle: ${circleId}, user: ${userAddress}`);
    console.log(`[DEBUG] Is localhost: ${isLocalhost()}`);

    // A read that fails answers 503, never `false`: "no request" would invite
    // a member whose request is already with the admin to send another.
    let hasPendingRequest: boolean;

    if (isLocalhost()) {
      // Use local SQLite database service for localhost
      console.log('[DEBUG] Using local SQLite database service');
      try {
        hasPendingRequest = databaseService.userHasPendingRequest(circleId, userAddress);
        console.log(`[DEBUG] SQLite pending request check result: ${hasPendingRequest}`);
      } catch (sqliteError) {
        return sendJoinRequestReadFailure(res, { route: 'check', circleId }, sqliteError);
      }
    } else {
      // Use PostgreSQL database for production
      console.log('[DEBUG] Using PostgreSQL database for production');
      try {
        hasPendingRequest = await joinRequestDatabase.checkPendingRequest(circleId, userAddress);
      } catch (dbError) {
        return sendJoinRequestReadFailure(res, { route: 'check', circleId }, dbError);
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