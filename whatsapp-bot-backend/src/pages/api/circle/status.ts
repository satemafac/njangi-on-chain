import type { NextApiRequest, NextApiResponse } from 'next';
import { circleStatusService } from '../../../services/circle-status.service';
import { appLogger } from '../../../utils/logger';

interface StatusResponse {
  success: boolean;
  message?: string;
  error?: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<StatusResponse>
) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed',
    });
  }

  try {
    const { circleId } = req.query as Record<string, string>;

    if (!circleId) {
      return res.status(400).json({
        success: false,
        error: 'circleId parameter is required',
      });
    }

    appLogger.debug('📊 Getting circle status', { circleId });

    const statusMessage = await circleStatusService.getCircleStatusMessage(circleId);

    return res.status(200).json({
      success: true,
      message: statusMessage,
    });
  } catch (error) {
    appLogger.error('Error in circle status endpoint', {
      error: error instanceof Error ? error.message : String(error),
    });

    return res.status(500).json({
      success: false,
      error: 'Failed to get circle status',
    });
  }
}

