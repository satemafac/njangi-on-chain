import { NextApiRequest, NextApiResponse } from 'next';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'POST') {
    // Handle Apple's form_post response
    const { id_token } = req.body;
    
    if (id_token) {
      // Redirect to the frontend callback page with the token in the URL
      const redirectUrl = `/auth/callback#id_token=${encodeURIComponent(id_token)}`;
      
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
      res.status(400).json({ error: 'No ID token received' });
    }
  } else {
    // Handle GET requests (for Google/Facebook fragment responses)
    res.status(405).json({ error: 'Method not allowed' });
  }
} 