import { NextApiRequest, NextApiResponse } from 'next';
import databaseService from '../../../../services/database-service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { circleId } = req.query;
    
    if (!circleId || typeof circleId !== 'string') {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing or invalid circleId parameter' 
      });
    }

    // Get pending requests for the circle
    const pendingRequests = databaseService.getPendingRequestsByCircleId(circleId);
    
    return res.status(200).json({ 
      success: true, 
      data: pendingRequests 
    });
  } catch (error) {
    console.error('API error getting pending requests:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
} 