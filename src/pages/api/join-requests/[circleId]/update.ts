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
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { circleId } = req.query;
    const { userAddress, status } = req.body;

    // Validate required fields
    if (!circleId || typeof circleId !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid circle ID'
      });
    }

    if (!userAddress || typeof userAddress !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid user address'
      });
    }

    if (!status || (status !== 'approved' && status !== 'rejected')) {
      return res.status(400).json({
        success: false,
        message: 'Status must be either "approved" or "rejected"'
      });
    }

    console.log(`[API] Updating join request for circle ${circleId}, user ${userAddress} to status ${status}`);

    // Update the join request status
    const success = await joinRequestDatabase.updateJoinRequestStatus(
      circleId,
      userAddress,
      status
    );

    if (!success) {
      console.log(`[API] Failed to update join request status in database`);
      return res.status(500).json({
        success: false,
        message: 'Failed to update join request status'
      });
    }

    console.log(`[API] Successfully updated join request status to ${status}`);
    return res.status(200).json({
      success: true
    });
  } catch (error) {
    console.error('Error updating join request:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update join request'
    });
  }
} 