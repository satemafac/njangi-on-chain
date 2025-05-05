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
    
    // Handle POST request to /get-salt endpoint
    if (req.method === "POST" && parsedUrl.pathname === "/get-salt") {
      let body = "";
      req.on("data", chunk => {
        body += chunk.toString();
      });
      
      req.on("end", async () => {
        try {
          const data = JSON.parse(body);
          const { sub, aud } = data;
          
          if (!sub || !aud) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing required parameters" }));
            return;
          }
          
          // Get salt from the database
          const saltData = await adapter.getSalt(sub, aud);
          
          // Check if salt data exists, if not, it means we need to create a new salt
          if (!saltData.id) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ salt: generateRandomSalt() }));
          } else {
            // In a real implementation, you would decrypt the salt here
            // For now, just return a dummy salt since we don't have the decryption logic
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ salt: "dummy-salt-for-testing" }));
          }
        } catch (error) {
          console.error("Error handling get-salt request:", error);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
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
  const length = 32; // 256 bits
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

main().catch(console.error); 