import type { NextApiRequest, NextApiResponse } from 'next';
import joinRequestDatabase from '../../../services/join-request-database';
import databaseService from '../../../services/database-service';

type ResponseData = {
  success: boolean;
  message?: string;
  data?: Record<string, unknown>;
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
    const { circleId, circleName, userAddress, userName } = req.body;

    // Validate required fields
    if (!circleId || !circleName || !userAddress) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    console.log(`[DEBUG] Creating join request for circle: ${circleId}, user: ${userAddress}`);
    console.log(`[DEBUG] Is localhost: ${isLocalhost()}`);

    let joinRequest = null;

    if (isLocalhost()) {
      // Use local SQLite database service for localhost
      console.log('[DEBUG] Using local SQLite database service');
      try {
        const localRequest = {
          circleId,
          circleName,
          userAddress,
          userName: userName || 'Anonymous',
          requestDate: Date.now(),
          status: 'pending' as const
        };
        
        joinRequest = databaseService.createJoinRequest(localRequest);
        console.log(`[DEBUG] SQLite join request created:`, joinRequest);
        
        if (!joinRequest) {
          throw new Error('Failed to create join request in SQLite database');
        }
      } catch (sqliteError) {
        console.error('[DEBUG] SQLite database error:', sqliteError);
        return res.status(500).json({
          success: false,
          message: 'Local database error: ' + (sqliteError as Error).message
        });
      }
    } else {
      // Use PostgreSQL database for production
      console.log('[DEBUG] Using PostgreSQL database for production');
      try {
        joinRequest = await joinRequestDatabase.createJoinRequest(
          circleId,
          circleName,
          userAddress,
          userName || 'Anonymous',
          'pending'
        );
      } catch (dbError) {
        console.error('[DEBUG] PostgreSQL database error:', dbError);
        return res.status(500).json({
          success: false,
          message: 'Database connection failed'
        });
      }
    }

    console.log(`[DEBUG] Join request created successfully: ${joinRequest ? `ID: ${joinRequest.id}` : 'No ID returned'}`);
    if (joinRequest) {
      console.log(`[DEBUG] Join request details:`, JSON.stringify(joinRequest));
    }

    return res.status(200).json({
      success: true,
      data: joinRequest ? { id: joinRequest.id } : { id: 0 }
    });
  } catch (error) {
    console.error('Error creating join request:', error);
    
    return res.status(500).json({
      success: false,
      message: 'Failed to create join request: ' + (error as Error).message
    });
  }
} 