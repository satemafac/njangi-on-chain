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
    const { userAddress } = req.query;

    // Validate required parameter
    if (!userAddress || typeof userAddress !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Missing or invalid user address'
      });
    }

    // Get all requests for this user
    const requests = await joinRequestDatabase.getRequestsByUserAddress(userAddress);

    // Return the requests
    return res.status(200).json({
      success: true,
      data: requests
    });
  } catch (error) {
    console.error('Error fetching user join requests:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch user join requests'
    });
  }
} 