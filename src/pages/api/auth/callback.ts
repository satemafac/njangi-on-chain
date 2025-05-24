import { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    // Handle Apple's form_post response
    console.log('Apple form_post data received:', req.body);
    
    const { id_token, user } = req.body;
    
    if (id_token) {
      // Extract any additional user data Apple might have sent
      let additionalData = '';
      if (user) {
        // Apple sometimes sends user profile data in a 'user' field
        console.log('Apple user profile data:', user);
        additionalData = `&user=${encodeURIComponent(JSON.stringify(user))}`;
      }
      
      // Redirect to the frontend callback page with the token and any additional data
      const redirectUrl = `/auth/callback#id_token=${encodeURIComponent(id_token)}${additionalData}`;
      
      // Return HTML that redirects with the token
      res.status(200).send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Processing Authentication...</title>
          </head>
          <body>
            <script>
              window.location.href = '${redirectUrl}';
            </script>
            <p>Processing authentication...</p>
          </body>
        </html>
      `);
    } else {
      console.error('No ID token in Apple response, received:', req.body);
      res.status(400).json({ error: 'No ID token received' });
    }
  } else {
    // Handle GET requests (for Google/Facebook fragment responses)
    res.status(405).json({ error: 'Method not allowed' });
  }
} 