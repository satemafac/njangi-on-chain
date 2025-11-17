import type { NextApiRequest, NextApiResponse } from 'next';
import { circleLinkListener } from '../../../services/circle-link-listener.service';
import { appLogger } from '../../../utils/logger';

interface CircleIdResponse {
  success: boolean;
  circleId?: string;
  error?: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<CircleIdResponse>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed',
    });
  }

  try {
    const { phoneNumber } = req.query as Record<string, string>;

    if (!phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'phoneNumber parameter is required',
      });
    }

    appLogger.debug('Looking up circle ID for phone', { phoneNumber });

    const circleId = circleLinkListener.getCircleIdForPhone(phoneNumber);

    if (!circleId) {
      return res.status(404).json({
        success: false,
        error: 'No circle linked for this phone number',
      });
    }

    return res.status(200).json({
      success: true,
      circleId,
    });
  } catch (error) {
    appLogger.error('Error getting circle ID', {
      error: error instanceof Error ? error.message : String(error),
    });

    return res.status(500).json({
      success: false,
      error: 'Failed to get circle ID',
    });
  }
}

