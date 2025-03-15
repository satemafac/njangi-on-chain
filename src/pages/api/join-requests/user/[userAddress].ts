import { NextApiRequest, NextApiResponse } from 'next';
import databaseService from '../../../../services/database-service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { userAddress } = req.query;
    
    if (!userAddress || typeof userAddress !== 'string') {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing or invalid userAddress parameter' 
      });
    }

    // Get all requests for the user
    const requests = databaseService.getRequestsByUserAddress(userAddress);
    
    return res.status(200).json({ 
      success: true, 
      data: requests 
    });
  } catch (error) {
    console.error('API error getting user requests:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
} 