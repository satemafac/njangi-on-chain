import type { NextApiRequest, NextApiResponse } from 'next';
import joinRequestDatabase, { JoinRequest } from '../../../services/join-request-database';

type ResponseData = {
  success: boolean;
  message?: string;
  data?: JoinRequest[];
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  const { circleId } = req.query;

  if (!circleId || typeof circleId !== 'string') {
    return res.status(400).json({ 
      success: false, 
      message: 'Invalid circle ID' 
    });
  }

  if (req.method === 'GET') {
    try {
      // Get all pending requests for this circle
      const requests = await joinRequestDatabase.getPendingRequestsByCircleId(circleId);
      
      return res.status(200).json({
        success: true,
        data: requests
      });
    } catch (error) {
      console.error('API error getting join requests:', error);
      return res.status(500).json({
        success: false,
        message: 'Internal server error'
      });
    }
  } else {
    return res.status(405).json({ 
      success: false, 
      message: 'Method not allowed' 
    });
  }
} 