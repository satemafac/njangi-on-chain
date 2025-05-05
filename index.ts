import { getDatabaseAdapter } from "./src/services/postgres-adapter";
import * as http from "http";
import * as url from "url";

// Initialize the database
async function main() {
  const adapter = await getDatabaseAdapter();
  await adapter.setup();
  console.log("Salt service database initialized");
  
  // Create a proper salt service HTTP server
  const server = http.createServer(async (req, res) => {
    // Set CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    
    // Handle OPTIONS request (preflight)
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    
    const parsedUrl = url.parse(req.url || "", true);
    
    // Handle GET requests to root path
    if (req.method === "GET" && parsedUrl.pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "running" }));
      return;
    }
    
    // Handle POST request to /get-salt endpoint or root path
    if (req.method === "POST" && (parsedUrl.pathname === "/get-salt" || parsedUrl.pathname === "/")) {
      let body = "";
      req.on("data", chunk => {
        body += chunk.toString();
      });
      
      req.on("end", async () => {
        try {
          console.log("Received request body:", body);
          
          // Try to parse the JSON request
          let data;
          try {
            data = JSON.parse(body);
          } catch {
            console.log("Failed to parse JSON, trying URL params");
            // If JSON parsing fails, check if the body is URL encoded
            const params = new URLSearchParams(body);
            data = Object.fromEntries(params);
          }
          
          console.log("Parsed request data:", data);
          
          // Extract sub and aud from the data
          let sub, aud;
          
          // Check if the request contains a JWT token
          if (data.token) {
            try {
              // Extract payload from JWT token (without verification)
              const tokenParts = data.token.split('.');
              if (tokenParts.length === 3) {
                // Decode the payload (middle part)
                const payloadJson = Buffer.from(tokenParts[1], 'base64').toString('utf8');
                const payload = JSON.parse(payloadJson);
                console.log("Extracted JWT payload:", payload);
                
                // Extract sub and aud from JWT payload
                sub = payload.sub;
                aud = payload.aud || payload.client_id || data.client_id;
              }
            } catch (tokenError) {
              console.error("Error extracting JWT payload:", tokenError);
            }
          }
          
          // If not found in JWT token, look in other common locations
          if (!sub) {
            sub = data.sub || data.subject || data.id || 
                 (data.payload && data.payload.sub) || 
                 (data.jwt && data.jwt.sub);
          }
          
          if (!aud) {
            aud = data.aud || data.audience || data.clientId || 
                 (data.payload && data.payload.aud) || 
                 (data.jwt && data.jwt.aud);
          }
          
          console.log("Extracted sub:", sub, "aud:", aud);
          
          if (!sub || !aud) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ 
              error: "Missing required parameters",
              received: data,
              needed: "sub and aud" 
            }));
            return;
          }
          
          // Get salt from the database
          try {
            const saltData = await adapter.getSalt(sub, aud);
            console.log("Retrieved salt data:", saltData);
            
            // Check if salt data exists, if not, create a new salt
            if (!saltData || !saltData.id) {
              const salt = generateRandomSalt();
              console.log("Generated new salt for", sub, aud);
              
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ salt }));
            } else {
              // In a real implementation, decrypt the salt here
              // For testing, return the salt value directly if present
              const salt = saltData.salt || "dummy-salt-for-testing";
              console.log("Returning existing salt for", sub, aud);
              
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ salt }));
            }
          } catch (dbError) {
            console.error("Database error:", dbError);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Database error", details: dbError.message }));
          }
        } catch (error) {
          console.error("Error handling get-salt request:", error);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error", details: error.message }));
        }
      });
      return;
    }
    
    // Handle unknown endpoints
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
  
  const port = process.env.PORT || 5002;
  server.listen(port, () => {
    console.log(`Salt service running on port ${port}`);
  });
}

// Helper function to generate a random salt
function generateRandomSalt() {
  // Generate a random number between 0 and 2^128-1
  const bytes = new Uint8Array(16); // 16 bytes = 128 bits
  
  // Generate random bytes
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  
  // Convert to a decimal string
  let result = "0";
  for (let i = 0; i < bytes.length; i++) {
    result = (BigInt(result) * 256n + BigInt(bytes[i])).toString();
  }
  
  return result;
}

main().catch(console.error); 