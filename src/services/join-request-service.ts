import axios from 'axios';
import { JoinRequest } from './database-service';

class JoinRequestService {
  // Create a new join request
  async createJoinRequest(
    circleId: string,
    circleName: string,
    userAddress: string,
    userName: string
  ): Promise<JoinRequest | null> {
    try {
      const response = await axios.post('/api/join-requests/create', {
        circleId,
        circleName,
        userAddress,
        userName
      });

      if (response.data.success) {
        return response.data.data as JoinRequest;
      }
      return null;
    } catch (error) {
      console.error('Error creating join request:', error);
      throw error;
    }
  }

  // Get all pending requests for a circle
  async getPendingRequestsByCircleId(circleId: string): Promise<JoinRequest[]> {
    try {
      const response = await axios.get(`/api/join-requests/${circleId}`);

      if (response.data.success) {
        return response.data.data as JoinRequest[];
      }
      return [];
    } catch (error) {
      console.error('Error getting pending requests:', error);
      return [];
    }
  }

  // Check if a user has a pending request for a circle
  async checkPendingRequest(circleId: string, userAddress: string): Promise<boolean> {
    try {
      const requests = await this.getPendingRequestsByCircleId(circleId);
      return requests.some(req => req.userAddress === userAddress && req.status === 'pending');
    } catch (error) {
      console.error('Error checking pending request:', error);
      return false;
    }
  }

  // Update join request status (approve/reject)
  async updateJoinRequestStatus(
    circleId: string,
    userAddress: string,
    status: 'approved' | 'rejected'
  ): Promise<boolean> {
    try {
      const response = await axios.put(`/api/join-requests/${circleId}/update`, {
        userAddress,
        status
      });

      return response.data.success;
    } catch (error) {
      console.error('Error updating join request status:', error);
      return false;
    }
  }

  // Get all requests for a user
  async getRequestsByUserAddress(userAddress: string): Promise<JoinRequest[]> {
    try {
      const response = await axios.get(`/api/join-requests/user/${userAddress}`);

      if (response.data.success) {
        return response.data.data as JoinRequest[];
      }
      return [];
    } catch (error) {
      console.error('Error getting user requests:', error);
      return [];
    }
  }
}

const joinRequestService = new JoinRequestService();
export default joinRequestService; 