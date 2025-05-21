import type { NextApiRequest, NextApiResponse } from 'next';
import joinRequestDatabase from '../../../services/join-request-database';

type ResponseData = {
  success: boolean;
  message?: string;
  data?: {
    hasPendingRequest: boolean;
  };
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

    // Check if user has a pending request
    const hasPendingRequest = await joinRequestDatabase.checkPendingRequest(circleId, userAddress);
    
    console.log(`[DEBUG] Pending request check result: ${hasPendingRequest}`);

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