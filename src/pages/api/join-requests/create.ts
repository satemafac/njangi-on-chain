import type { NextApiRequest, NextApiResponse } from 'next';
import joinRequestDatabase from '../../../services/join-request-database';

type ResponseData = {
  success: boolean;
  message?: string;
  data?: Record<string, unknown>;
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

    // Create the join request with explicit status
    const joinRequest = await joinRequestDatabase.createJoinRequest(
      circleId,
      circleName,
      userAddress,
      userName || 'Anonymous',
      'pending' // Explicitly set status to 'pending'
    );

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
      message: 'Failed to create join request'
    });
  }
} 