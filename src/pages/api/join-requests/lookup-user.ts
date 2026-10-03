import type { NextApiRequest, NextApiResponse } from 'next';
import joinRequestDatabase from '../../../services/join-request-database';
import { requireCircleParticipant, sendJoinRequestAuthFailure } from '../../../lib/join-request-auth';

type ResponseData = {
  success: boolean;
  message?: string;
  data?: {
    userName: string | null;
    circleName: string | null;
  };
};

/**
 * Looks up the display name a member gave when they applied to a circle.
 * Used by the contribute page to show members' names. Only the circle's
 * admin and members may read them: a name tied to an on-chain address is
 * personal data. Server code (the WhatsApp status reply) reads the same row
 * in-process through `joinRequestDatabase.getUserByAddress`.
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

    const auth = await requireCircleParticipant(req, circleId);
    if (!auth.ok) {
      return sendJoinRequestAuthFailure(res, auth);
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

