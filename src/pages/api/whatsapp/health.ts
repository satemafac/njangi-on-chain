import { NextApiRequest, NextApiResponse } from 'next';
import { WhatsAppService } from '../../../services/whatsapp.service';
import { validateWhatsAppConfig } from '../../../config/whatsapp.config';

const whatsappService = WhatsAppService.getInstance();

interface HealthCheckResponse {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  services: {
    whatsappApi: boolean;
    configuration: boolean;
  };
  stats: Record<string, unknown>;
  errors?: string[];
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<HealthCheckResponse>) {
  try {
    // Only allow GET requests
    if (req.method !== 'GET') {
      res.setHeader('Allow', ['GET']);
      return res.status(405).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        services: {
          whatsappApi: false,
          configuration: false,
        },
        stats: {},
        errors: [`Method ${req.method} not allowed`],
      });
    }

    const errors: string[] = [];
    const services = {
      whatsappApi: false,
      configuration: false,
    };

    // Check configuration
    services.configuration = validateWhatsAppConfig();
    if (!services.configuration) {
      errors.push('WhatsApp configuration is invalid or incomplete');
    }

    // Check WhatsApp API connectivity (only if configuration is valid)
    if (services.configuration) {
      try {
        services.whatsappApi = await whatsappService.healthCheck();
        if (!services.whatsappApi) {
          errors.push('WhatsApp API is not responding');
        }
      } catch (error) {
        errors.push(`WhatsApp API health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Get service statistics
    const stats = whatsappService.getStats();

    // Determine overall health status
    const isHealthy = services.configuration && services.whatsappApi;

    const response: HealthCheckResponse = {
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      services,
      stats,
    };

    if (errors.length > 0) {
      response.errors = errors;
    }

    // Return appropriate HTTP status code
    const statusCode = isHealthy ? 200 : 503;
    return res.status(statusCode).json(response);

  } catch (error) {
    console.error('Health check error:', error);
    
    return res.status(500).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      services: {
        whatsappApi: false,
        configuration: false,
      },
      stats: {},
      errors: ['Internal server error during health check'],
    });
  }
} 