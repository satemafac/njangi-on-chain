import { NextApiRequest, NextApiResponse } from 'next';
import type { AutomationCronService } from '../../../services/automation-cron.service';

// Global variable to track if automation is already running
let automationServiceInstance: AutomationCronService | null = null;

/**
 * 🚀 Automation Service Startup API
 * 
 * Initializes and starts the automation cron service
 * Prevents multiple instances from running simultaneously
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({
      success: false,
      error: 'Method not allowed'
    });
  }

  try {
    // Check if automation service is already running
    if (automationServiceInstance) {
      return res.status(200).json({
        success: true,
        message: 'Automation service is already running',
        status: 'already_running'
      });
    }

    // Check if required environment variables are present
    const requiredEnvVars = ['ADMIN_PRIVATE_KEY'];
    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      console.warn('❌ Cannot start automation service - missing environment variables:', missingVars);
      return res.status(200).json({
        success: false,
        error: 'Missing required environment variables',
        missingVars,
        status: 'configuration_error'
      });
    }

    // Dynamically import and start the automation service
    const { automationService } = await import('../../../services/automation-cron.service');
    
    // Start the automation service
    await automationService.start();
    
    // Store the instance to prevent multiple starts
    automationServiceInstance = automationService;
    
    console.log('🚀 Automation service started successfully from API endpoint');
    
    return res.status(200).json({
      success: true,
      message: 'Automation service started successfully',
      status: 'started',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Failed to start automation service:', error);
    
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      status: 'startup_error'
    });
  }
}

// Cleanup function for graceful shutdown
export const stopAutomationService = async () => {
  if (automationServiceInstance) {
    try {
      await automationServiceInstance.stop();
      automationServiceInstance = null;
      console.log('🛑 Automation service stopped successfully');
    } catch (error) {
      console.error('❌ Error stopping automation service:', error);
    }
  }
};

// Handle process termination
if (typeof process !== 'undefined') {
  process.on('SIGTERM', stopAutomationService);
  process.on('SIGINT', stopAutomationService);
} 