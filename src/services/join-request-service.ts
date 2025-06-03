import axios from 'axios';
import { JoinRequest } from './join-request-database';

// Check if we're running on localhost
const isLocalhost = () => {
  if (typeof window !== 'undefined') {
    return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  }
  return process.env.NODE_ENV === 'development';
};

// Simple local database fallback for localhost (in-memory storage)
class LocalJoinRequestStore {
  private requests: JoinRequest[] = [];
  private idCounter = 1;

  createJoinRequest(
    circleId: string,
    circleName: string,
    userAddress: string,
    userName: string
  ): JoinRequest {
    const existingIndex = this.requests.findIndex(
      req => req.circle_id === circleId && req.user_address === userAddress
    );

    const request: JoinRequest = {
      id: existingIndex >= 0 ? this.requests[existingIndex].id : this.idCounter++,
      circle_id: circleId,
      circle_name: circleName,
      user_address: userAddress,
      user_name: userName,
      status: 'pending',
      created_at: new Date(),
      updated_at: new Date()
    };

    if (existingIndex >= 0) {
      this.requests[existingIndex] = request;
    } else {
      this.requests.push(request);
    }

    console.log('[LocalStore] Created/updated join request:', request);
    return request;
  }

  getPendingRequestsByCircleId(circleId: string): JoinRequest[] {
    const pending = this.requests.filter(
      req => req.circle_id === circleId && req.status === 'pending'
    );
    console.log(`[LocalStore] Found ${pending.length} pending requests for circle: ${circleId}`);
    return pending;
  }

  updateJoinRequestStatus(
    circleId: string,
    userAddress: string,
    status: 'approved' | 'rejected'
  ): boolean {
    const index = this.requests.findIndex(
      req => req.circle_id === circleId && req.user_address === userAddress
    );

    if (index >= 0) {
      this.requests[index].status = status;
      this.requests[index].updated_at = new Date();
      console.log(`[LocalStore] Updated request status to ${status}:`, this.requests[index]);
      return true;
    }

    console.log(`[LocalStore] No request found to update for circle: ${circleId}, user: ${userAddress}`);
    return false;
  }

  getRequestsByUserAddress(userAddress: string): JoinRequest[] {
    const userRequests = this.requests.filter(req => req.user_address === userAddress);
    console.log(`[LocalStore] Found ${userRequests.length} requests for user: ${userAddress}`);
    return userRequests;
  }

  // Add some mock data for testing
  addMockData() {
    this.requests.push({
      id: this.idCounter++,
      circle_id: 'mock-circle-1',
      circle_name: 'Test Circle 1',
      user_address: '0x123...',
      user_name: 'Test User',
      status: 'pending',
      created_at: new Date(),
      updated_at: new Date()
    });
    console.log('[LocalStore] Added mock data for testing');
  }
}

// Singleton instance for localhost testing
const localStore = new LocalJoinRequestStore();

// Local database access functions (only for localhost)
const getLocalDatabase = async () => {
  if (!isLocalhost()) {
    throw new Error('Local database access only available on localhost');
  }
  
  // For localhost testing, use our in-memory store
  if (localStore) {
    // Add some mock data if store is empty
    if (localStore.getPendingRequestsByCircleId('mock-circle-1').length === 0) {
      localStore.addMockData();
    }
  }
  
  return localStore;
};

class JoinRequestService {
  // Create a new join request
  async createJoinRequest(
    circleId: string,
    circleName: string,
    userAddress: string,
    userName: string
  ): Promise<JoinRequest | null> {
    try {
      // For localhost, use local API endpoint
      const baseUrl = isLocalhost() ? 'http://localhost:3000' : '';
      const response = await axios.post(`${baseUrl}/api/join-requests/create`, {
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
      
      // If running on localhost and API fails, try local store as fallback
      if (isLocalhost()) {
        try {
          console.log('[JoinRequestService] Create API failed on localhost, using local store...');
          const store = await getLocalDatabase();
          if (store) {
            return store.createJoinRequest(circleId, circleName, userAddress, userName);
          }
        } catch (storeError) {
          console.error('Local store access also failed:', storeError);
        }
      }
      
      throw error;
    }
  }

  // Get all pending requests for a circle
  async getPendingRequestsByCircleId(circleId: string): Promise<JoinRequest[]> {
    try {
      // For localhost, use local API endpoint
      const baseUrl = isLocalhost() ? 'http://localhost:3000' : '';
      const response = await axios.get(`${baseUrl}/api/join-requests/pending/${circleId}`);

      if (response.data.success) {
        return response.data.data as JoinRequest[];
      }
      return [];
    } catch (error) {
      console.error('Error getting pending requests:', error);
      
      // If running on localhost and API fails, try local store as fallback
      if (isLocalhost()) {
        try {
          console.log('[JoinRequestService] API failed on localhost, using local store...');
          const store = await getLocalDatabase();
          if (store) {
            return store.getPendingRequestsByCircleId(circleId);
          }
        } catch (storeError) {
          console.error('Local store access also failed:', storeError);
        }
      }
      
      return [];
    }
  }

  // Check if a user has a pending request for a circle
  async checkPendingRequest(circleId: string, userAddress: string): Promise<boolean> {
    try {
      const requests = await this.getPendingRequestsByCircleId(circleId);
      return requests.some(req => req.user_address === userAddress && req.status === 'pending');
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
      // For localhost, use local API endpoint
      const baseUrl = isLocalhost() ? 'http://localhost:3000' : '';
      const response = await axios.put(`${baseUrl}/api/join-requests/${circleId}/update`, {
        userAddress,
        status
      });

      return response.data.success;
    } catch (error) {
      console.error('Error updating join request status:', error);
      
      // If running on localhost and API fails, try local store as fallback
      if (isLocalhost()) {
        try {
          console.log('[JoinRequestService] Update API failed on localhost, using local store...');
          const store = await getLocalDatabase();
          if (store) {
            return store.updateJoinRequestStatus(circleId, userAddress, status);
          }
        } catch (storeError) {
          console.error('Local store update also failed:', storeError);
        }
      }
      
      return false;
    }
  }

  // Get all requests for a user
  async getRequestsByUserAddress(userAddress: string): Promise<JoinRequest[]> {
    try {
      // For localhost, use local API endpoint
      const baseUrl = isLocalhost() ? 'http://localhost:3000' : '';
      const response = await axios.get(`${baseUrl}/api/join-requests/user/${userAddress}`);

      if (response.data.success) {
        return response.data.data as JoinRequest[];
      }
      return [];
    } catch (error) {
      console.error('Error getting user requests:', error);
      
      // If running on localhost and API fails, try local store as fallback
      if (isLocalhost()) {
        try {
          console.log('[JoinRequestService] User requests API failed on localhost, using local store...');
          const store = await getLocalDatabase();
          if (store) {
            return store.getRequestsByUserAddress(userAddress);
          }
        } catch (storeError) {
          console.error('Local store access also failed:', storeError);
        }
      }
      
      return [];
    }
  }

  // Helper method to check if we're using localhost
  isUsingLocalhost(): boolean {
    return isLocalhost();
  }

  // Helper method to add mock data for testing (localhost only)
  async addMockDataForTesting(circleId: string, circleName: string): Promise<void> {
    if (!isLocalhost()) {
      console.warn('Mock data can only be added on localhost');
      return;
    }

    try {
      const store = await getLocalDatabase();
      if (store) {
        store.createJoinRequest(circleId, circleName, '0xtest123', 'Test User 1');
        store.createJoinRequest(circleId, circleName, '0xtest456', 'Test User 2');
        console.log(`[JoinRequestService] Added mock join requests for circle: ${circleId}`);
      }
    } catch (error) {
      console.error('Error adding mock data:', error);
    }
  }
}

const joinRequestService = new JoinRequestService();
export default joinRequestService; 