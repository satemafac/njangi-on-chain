import type { NextApiRequest, NextApiResponse } from 'next';
import joinRequestDatabase from '../../../services/join-request-database';

type ResponseData = {
  success: boolean;
  message?: string;
  data?: {
    userName: string | null;
    circleName: string | null;
  };
};

/**
 * API endpoint to look up user name from join requests database
 * Used by WhatsApp bot to include names in notifications
 */
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

    console.log(`[LookupUser] Looking up user: ${userAddress} for circle: ${circleId}`);

    // Look up the user in the join requests database
    // This will find any request (pending, approved, or rejected) for this user/circle combination
    const userData = await joinRequestDatabase.getUserByAddress(circleId, userAddress);

    if (userData) {
      console.log(`[LookupUser] Found user: ${userData.user_name} for circle: ${userData.circle_name}`);
      return res.status(200).json({
        success: true,
        data: {
          userName: userData.user_name,
          circleName: userData.circle_name
        }
      });
    }

    console.log(`[LookupUser] No user found for address: ${userAddress}`);
    return res.status(200).json({
      success: true,
      data: {
        userName: null,
        circleName: null
      }
    });
  } catch (error) {
    console.error('[LookupUser] Error looking up user:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to look up user'
    });
  }
}

