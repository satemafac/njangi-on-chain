import type { NextApiRequest, NextApiResponse } from 'next';
import joinRequestDatabase from '../../../services/join-request-database';

type ResponseData = {
  success: boolean;
  message?: string;
  data?: any;
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

    // Create the join request
    const joinRequest = await joinRequestDatabase.createJoinRequest(
      circleId,
      circleName,
      userAddress,
      userName || 'Unknown User'
    );

    if (joinRequest) {
      return res.status(200).json({
        success: true,
        data: joinRequest
      });
    } else {
      return res.status(500).json({
        success: false,
        message: 'Failed to create join request'
      });
    }
  } catch (error) {
    console.error('API error creating join request:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
} 