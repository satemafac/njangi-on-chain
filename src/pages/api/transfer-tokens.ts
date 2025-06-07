// DEPRECATED: This API endpoint is deprecated. Use AuthContext.sendTokens() instead.
// The new implementation provides better authentication flow and error handling.
// This endpoint will be removed in a future version.

import { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return res.status(410).json({
    error: 'This API endpoint is deprecated. Please use the AuthContext.sendTokens() method instead.',
    message: 'Transfer functionality has been moved to the main authentication flow for better security and session management.',
    migration: 'Update your code to use the sendTokens method from useAuth() hook.',
    deprecated: true
  });
} 