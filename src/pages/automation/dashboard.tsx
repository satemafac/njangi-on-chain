import React, { useState, useEffect } from 'react';
import { CheckCircle, Activity, BarChart3, PlayCircle } from 'lucide-react';
import { toast } from 'react-hot-toast';

interface DashboardData {
  health: { status: 'healthy' | 'warning' | 'critical'; uptime: number; };
  metrics: {
    activeCircles: number;
    payoutsTriggered: number;
    notificationsSent: number;
    successRate: number;
    isRunning: boolean;
    emergencyStop: boolean;
    retryQueueSize: number;
  };
  alerts: Array<{
    id: string;
    type: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    message: string;
    timestamp: string;
  }>;
}

export default function AutomationDashboard() {
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchDashboardData = async () => {
    try {
      const response = await fetch('/api/automation/dashboard');
      const result = await response.json();
      if (result.success) {
        setDashboardData(result.data);
      } else {
        toast.error('Failed to fetch dashboard data');
      }
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
      toast.error('Error loading dashboard');
    }
  };

  useEffect(() => {
    // Load dashboard data regardless of authentication status
    fetchDashboardData();
    setLoading(false);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <h1 className="text-2xl font-bold text-gray-900 flex items-center">
            <Activity className="mr-3 h-8 w-8 text-blue-600" />
            Automation Dashboard
          </h1>
          <p className="text-gray-600">Monitor Njangi automation system status</p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {dashboardData && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
                              <div className="bg-white p-6 rounded-lg shadow">
                  <div className="flex items-center">
                    <CheckCircle className="h-8 w-8 text-green-600 mr-3" />
                    <div>
                      <p className="text-sm text-gray-600">System Status</p>
                      <p className="text-lg font-semibold text-green-600 capitalize">
                        {dashboardData.health?.status || 'Unknown'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="bg-white p-6 rounded-lg shadow">
                  <div className="flex items-center">
                    <BarChart3 className="h-8 w-8 text-blue-600 mr-3" />
                    <div>
                      <p className="text-sm text-gray-600">Active Circles</p>
                      <p className="text-2xl font-bold text-gray-900">
                        {dashboardData.metrics?.activeCircles || 0}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="bg-white p-6 rounded-lg shadow">
                  <div className="flex items-center">
                    <PlayCircle className="h-8 w-8 text-green-600 mr-3" />
                    <div>
                      <p className="text-sm text-gray-600">Payouts Triggered</p>
                      <p className="text-2xl font-bold text-gray-900">
                        {dashboardData.metrics?.payoutsTriggered || 0}
                      </p>
                    </div>
                  </div>
                </div>

                              <div className="bg-white p-6 rounded-lg shadow">
                  <div className="flex items-center">
                    <CheckCircle className="h-8 w-8 text-purple-600 mr-3" />
                    <div>
                      <p className="text-sm text-gray-600">Success Rate</p>
                      <p className="text-2xl font-bold text-gray-900">
                        {(dashboardData.metrics.successRate || 0).toFixed(1)}%
                      </p>
                    </div>
                  </div>
                </div>
            </div>

                          <div className="bg-white p-6 rounded-lg shadow">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">System Status</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="flex justify-between">
                    <span>Running Status:</span>
                    <span className={dashboardData.metrics?.isRunning ? 'text-green-600' : 'text-red-600'}>
                      {dashboardData.metrics?.isRunning ? 'Running' : 'Stopped'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Emergency Stop:</span>
                    <span className={dashboardData.metrics?.emergencyStop ? 'text-red-600' : 'text-green-600'}>
                      {dashboardData.metrics?.emergencyStop ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>
              </div>
          </>
        )}
      </div>
    </div>
  );
}
