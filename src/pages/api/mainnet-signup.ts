import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import mainnetSignupDatabase from '../../services/mainnet-signup-database';
import { getClientIp } from '../../lib/client-ip';
import { consumeRateLimit } from '../../lib/rate-limit';

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

// Abuse guards: unauthenticated marketing signup, so cap lengths, throttle
// per IP+identity, and trap naive bots with a honeypot field.
const REQUESTS_PER_MINUTE = 5;
const MINUTE_WINDOW_MS = 60_000;

const signupSchema = z.object({
  email: z.string().trim().max(254),
  name: z.string().trim().max(120).optional(),
  userAddress: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{1,64}$/, 'Invalid Sui address format')
    .optional(),
  notificationPreferences: z
    .object({ email: z.boolean().default(true), sms: z.boolean().default(false) })
    .optional(),
  signupSource: z.string().trim().max(60).optional(),
  // Honeypot — hidden in the UI; real users never fill it.
  website: z.string().optional(),
});

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
    const parsed = signupSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: 'Invalid signup payload'
      });
    }
    const { email, name, userAddress, notificationPreferences, signupSource, website } = parsed.data;

    // Validate email format
    if (!email || !emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid email address'
      });
    }

    // Normalize email
    const normalizedEmail = email.toLowerCase();

    // Honeypot tripped — pretend success without touching the database.
    if (website && website.length > 0) {
      return res.status(200).json({
        success: true,
        message: 'Successfully signed up for mainnet launch notifications!'
      });
    }

    // Throttle per IP + claimed identity before any database work.
    const rateOutcome = consumeRateLimit({
      key: `mainnet-signup:${getClientIp(req)}:${userAddress?.toLowerCase() || normalizedEmail}`,
      limit: REQUESTS_PER_MINUTE,
      windowMs: MINUTE_WINDOW_MS,
    });
    if (!rateOutcome.allowed) {
      res.setHeader('Retry-After', String(Math.ceil(rateOutcome.resetMs / 1000)));
      return res.status(429).json({
        success: false,
        message: 'Too many signup attempts. Please wait a moment and try again.'
      });
    }

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