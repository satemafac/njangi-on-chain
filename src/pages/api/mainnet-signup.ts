import { NextApiRequest, NextApiResponse } from 'next';
import mainnetSignupDatabase from '../../services/mainnet-signup-database';

type ResponseData = {
  success: boolean;
  message?: string;
  data?: {
    id?: number;
    email?: string;
    alreadyExists?: boolean;
    signupCount?: number;
  };
};

// Email validation regex
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  if (req.method === 'POST') {
    return handleSignup(req, res);
  } else if (req.method === 'GET') {
    return handleGetStats(req, res);
  } else {
    return res.status(405).json({ 
      success: false, 
      message: 'Method not allowed' 
    });
  }
}

async function handleSignup(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  try {
    const { email, name, userAddress, notificationPreferences, signupSource } = req.body;

    // Validate required fields
    if (!email || typeof email !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Email is required'
      });
    }

    // Validate email format
    if (!emailRegex.test(email.trim())) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid email address'
      });
    }

    // Normalize email
    const normalizedEmail = email.trim().toLowerCase();

    // Check if email already exists
    const emailExists = await mainnetSignupDatabase.emailExists(normalizedEmail);

    console.log(`[API] Mainnet signup attempt: email=${normalizedEmail}, exists=${emailExists}`);

    // Create or update the signup
    const signup = await mainnetSignupDatabase.createSignup(
      normalizedEmail,
      name?.trim() || undefined,
      userAddress || undefined,
      notificationPreferences || { email: true, sms: false },
      signupSource || 'homepage'
    );

    if (!signup) {
      return res.status(500).json({
        success: false,
        message: 'Failed to process signup. Please try again.'
      });
    }

    console.log(`[API] Mainnet signup successful: ID=${signup.id}, email=${signup.email}`);

    return res.status(200).json({
      success: true,
      message: emailExists 
        ? 'Your signup information has been updated!' 
        : 'Successfully signed up for mainnet launch notifications!',
      data: {
        id: signup.id,
        email: signup.email,
        alreadyExists: emailExists
      }
    });
  } catch (error) {
    console.error('Error processing mainnet signup:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error. Please try again later.'
    });
  }
}

async function handleGetStats(
  req: NextApiRequest,
  res: NextApiResponse<ResponseData>
) {
  try {
    // Get signup count for public display
    const count = await mainnetSignupDatabase.getSignupCount();

    return res.status(200).json({
      success: true,
      data: {
        signupCount: count
      }
    });
  } catch (error) {
    console.error('Error getting mainnet signup stats:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to get signup statistics'
    });
  }
} 