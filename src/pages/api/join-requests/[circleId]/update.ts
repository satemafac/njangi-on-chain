import type { NextApiRequest, NextApiResponse } from 'next';
import joinRequestDatabase from '../../../../services/join-request-database';

type ResponseData = {
  success: boolean;
  message?: string;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method !== 'PUT') {
    return res.status(405).json({ 
      success: false, 
      message: 'Method not allowed' 
    });
  }

  const { circleId } = req.query;
  const { userAddress, status } = req.body;

  if (!circleId || typeof circleId !== 'string') {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid circle ID' 
    });
  }

  if (!userAddress) {
    return res.status(400).json({ 
      success: false, 
      message: 'User address is required' 
    });
  }

  if (status !== 'approved' && status !== 'rejected') {
    return res.status(400).json({ 
      success: false, 
      message: 'Status must be either "approved" or "rejected"' 
    });
  }

  try {
    const result = await joinRequestDatabase.updateJoinRequestStatus(
      circleId,
      userAddress,
      status
    );

    if (result) {
      return res.status(200).json({
        success: true,
        message: `Join request ${status}`
      });
    } else {
      return res.status(404).json({
        success: false,
        message: 'Join request not found'
      });
    }
  } catch (error) {
    console.error('API error updating join request:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
} 