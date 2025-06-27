import { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // Only allow GET requests for this test
    if (req.method !== 'GET') {
      res.setHeader('Allow', ['GET']);
      return res.status(405).json({ error: `Method ${req.method} not allowed` });
    }

    const { phone } = req.query;

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ 
        error: 'Phone number parameter is required' 
      });
    }

    // Test the auth notification endpoint
    const testNotification = {
      token: 'test-token-123',
      phone: phone.startsWith('+') ? phone : `+${phone}`,
      success: true,
      message: 'Test authentication notification - this is a test message from the development team!'
    };

    const response = await fetch(`${req.headers.host ? `http://${req.headers.host}` : 'http://localhost:3000'}/api/whatsapp/auth/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testNotification),
    });

    const result = await response.json();

    return res.status(200).json({
      success: true,
      message: 'Test notification sent',
      notifyResponse: result,
      notifyStatus: response.status,
    });

  } catch (error) {
    console.error('Error in test auth notification API:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
} 