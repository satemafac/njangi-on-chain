import type { NextApiRequest, NextApiResponse } from 'next';
import joinRequestDatabase, { JoinRequest } from '../../../../services/join-request-database';

type ResponseData = {
  success: boolean;
  message?: string;
  data?: JoinRequest[];
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

    // Get only pending requests for this circle ID
    const requests = await joinRequestDatabase.getPendingRequestsByCircleId(circleId);

    // Return the pending requests
    return res.status(200).json({
      success: true,
      data: requests
    });
  } catch (error) {
    console.error('Error fetching pending join requests:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch pending join requests'
    });
  }
} 