import type { NextApiRequest, NextApiResponse } from 'next';
import joinRequestDatabase, { JoinRequest } from '../../../services/join-request-database';
import databaseService from '../../../services/database-service';

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
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { circleId } = req.query;

    // Validate required parameter
    if (!circleId || typeof circleId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid circle ID'
      });
    }

    console.log(`[API] Fetching all join requests for circle: ${circleId}`);
    console.log(`[API] Is localhost: ${isLocalhost()}`);

    let requests: JoinRequest[] = [];

    if (isLocalhost()) {
      // Use local SQLite database service for localhost
      console.log('[API] Using local SQLite database service');
      try {
        requests = databaseService.getRequestsByCircleId(circleId);
        console.log(`[API] SQLite found ${requests.length} requests for circle ${circleId}`);
      } catch (sqliteError) {
        console.error('[API] SQLite database error:', sqliteError);
        requests = [];
      }
    } else {
      // Use PostgreSQL database for production
      console.log('[API] Using PostgreSQL database for production');
      try {
        requests = await joinRequestDatabase.getRequestsByCircleId(circleId);
      } catch (dbError) {
        console.error('[API] PostgreSQL database error:', dbError);
        requests = [];
      }
    }

    // Return the requests
    return res.status(200).json({
      success: true,
      data: requests
    });
  } catch (error) {
    console.error('Error fetching join requests:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch join requests: ' + (error as Error).message
    });
  }
} 