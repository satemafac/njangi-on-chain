import { NextApiRequest, NextApiResponse } from 'next';
import databaseService from '../../../../services/database-service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only allow PUT requests
  if (req.method !== 'PUT') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { circleId } = req.query;
    const { userAddress, status } = req.body;
    
    if (!circleId || typeof circleId !== 'string') {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing or invalid circleId parameter' 
      });
    }

    if (!userAddress) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing userAddress in request body' 
      });
    }

    if (!status || (status !== 'approved' && status !== 'rejected')) {
      return res.status(400).json({ 
        success: false, 
        message: 'Status must be either "approved" or "rejected"' 
      });
    }

    // Update join request status
    const success = databaseService.updateJoinRequestStatus(circleId, userAddress, status);
    
    if (success) {
      return res.status(200).json({ 
        success: true, 
        message: `Join request ${status === 'approved' ? 'approved' : 'rejected'} successfully` 
      });
    } else {
      return res.status(404).json({ 
        success: false, 
        message: 'Join request not found or already processed' 
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