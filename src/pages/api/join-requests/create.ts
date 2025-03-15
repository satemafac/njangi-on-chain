import { NextApiRequest, NextApiResponse } from 'next';
import databaseService, { JoinRequest } from '../../../services/database-service';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { circleId, circleName, userAddress, userName } = req.body;

    // Validate required fields
    if (!circleId || !userAddress) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields: circleId and userAddress are required' 
      });
    }

    // Check if user already has a pending request for this circle
    const hasPendingRequest = databaseService.userHasPendingRequest(circleId, userAddress);
    if (hasPendingRequest) {
      return res.status(400).json({ 
        success: false, 
        message: 'You already have a pending request for this circle' 
      });
    }

    // Create join request
    const joinRequest: JoinRequest = {
      circleId,
      circleName: circleName || 'Unknown Circle',
      userAddress,
      userName: userName || 'Unknown User',
      requestDate: Date.now(),
      status: 'pending'
    };

    const result = databaseService.createJoinRequest(joinRequest);
    
    if (result) {
      return res.status(201).json({ 
        success: true, 
        message: 'Join request created successfully',
        data: result
      });
    } else {
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to create join request' 
      });
    }
  } catch (error) {
    console.error('API error creating join request:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'Internal server error' 
    });
  }
} 