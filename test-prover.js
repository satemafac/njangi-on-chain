/**
 * Test script for zkLogin prover service
 * 
 * This script sends a test request to the local prover service
 * to verify that it's responding correctly.
 */

const fetch = require('node-fetch');

// Constants from your configuration
const PROVER_URL = 'http://localhost:5001/v1';

async function testProverService() {
  console.log('Testing zkLogin prover service...');
  
  try {
    // First, check if the service is running with a simple ping
    const pingResponse = await fetch('http://localhost:5001/ping');
    if (!pingResponse.ok) {
      throw new Error(`Ping failed with status: ${pingResponse.status}`);
    }
    
    const pingText = await pingResponse.text();
    console.log(`Ping response: ${pingText}`);
    
    // Send a simple test request to make sure the /v1 endpoint is accessible
    // This will fail with a 400 error since we're not sending valid data,
    // but we just want to confirm the endpoint exists
    const testResponse = await fetch(PROVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true })
    });
    
    const statusCode = testResponse.status;
    const responseText = await testResponse.text();
    
    // 400 is expected because we're not sending correct parameters
    // But it confirms the endpoint exists and is processing requests
    console.log(`Test request status: ${statusCode}`);
    console.log(`Test response: ${responseText}`);
    
    if (statusCode === 400 || statusCode === 422) {
      console.log('✅ Prover service is responding as expected with validation errors (this is good)');
      console.log('The prover service is correctly set up and running!');
    } else if (statusCode >= 200 && statusCode < 300) {
      console.log('✅ Prover service responded with a success status (unexpected but good)');
    } else {
      console.log('⚠️ Prover service responded with an unexpected status code');
      console.log('Please check the Docker logs for more information');
    }
  } catch (error) {
    console.error('❌ Error testing prover service:', error.message);
    console.log('Please ensure:');
    console.log('1. Docker containers are running (docker ps)');
    console.log('2. The zkLogin.zkey file exists and is valid');
    console.log('3. The PROVER_URL in zkLoginService.ts is set to http://localhost:5001/v1');
  }
}

testProverService(); 