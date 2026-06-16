import { NextApiRequest, NextApiResponse } from 'next';

// Apple Sign In uses response_mode=form_post (it must, when email/name scopes
// are requested), so Apple POSTs the id_token to this server route instead of
// returning it in a URL fragment like Google/Facebook. We cannot keep the
// token in a query string (it would leak into server logs, history, and
// Referer), so we bounce it to the client callback in the URL *fragment*,
// which the browser never sends to a server.
//
// The bounce must survive environments where a lone inline <script> does NOT
// run — in-app webviews (WhatsApp/Mail/IG), strict CSP, JS disabled (see
// docs/in-app-browser-oauth.md). So we provide THREE escalating mechanisms:
//   1. inline script (fastest, normal browsers),
//   2. <meta http-equiv="refresh"> (no-JS fallback),
//   3. a visible manual "Continue" link (bulletproof last resort).

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    // Google/Facebook use response_mode=fragment and never reach this route.
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { id_token, user, error, error_description } = req.body ?? {};

  // Surface a provider error to the client callback (in the fragment) rather
  // than dead-ending on a blank page.
  if (!id_token) {
    if (error) {
      const errUrl = `/auth/callback#error=${encodeURIComponent(String(error))}${
        error_description ? `&error_description=${encodeURIComponent(String(error_description))}` : ''
      }`;
      sendBridge(res, errUrl);
      return;
    }
    console.error('No ID token in Apple response, received keys:', Object.keys(req.body ?? {}));
    res.status(400).json({ error: 'No ID token received' });
    return;
  }

  let additionalData = '';
  if (user) {
    // Apple sends profile data (name/email) only on the FIRST authorization.
    additionalData = `&user=${encodeURIComponent(
      typeof user === 'string' ? user : JSON.stringify(user),
    )}`;
  }

  const redirectUrl = `/auth/callback#id_token=${encodeURIComponent(String(id_token))}${additionalData}`;
  sendBridge(res, redirectUrl);
}

function sendBridge(res: NextApiResponse, redirectUrl: string) {
  const jsTarget = JSON.stringify(redirectUrl); // safe inside a JS string literal
  const attrTarget = escapeHtmlAttr(redirectUrl); // safe inside an HTML attribute

  // Explicit Content-Type (Next defaults strings to text/html, but be explicit
  // so a webview never renders this as plain text).
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=${attrTarget}" />
    <title>Completing sign in…</title>
    <script>
      // Primary path: replace() so this bridge isn't left in history.
      try { window.location.replace(${jsTarget}); }
      catch (e) { try { window.location.href = ${jsTarget}; } catch (_) {} }
    </script>
  </head>
  <body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#fbfaf7;color:#171923">
    <div style="text-align:center;max-width:22rem;padding:1.5rem">
      <p style="font-size:1rem;font-weight:600;margin:0 0 .5rem">Completing sign in…</p>
      <p style="font-size:.875rem;color:#5f6674;margin:0 0 1.25rem">If you are not redirected automatically, tap Continue.</p>
      <a href="${attrTarget}"
         style="display:inline-block;padding:.625rem 1.25rem;border-radius:9999px;background:#171923;color:#fff;text-decoration:none;font-weight:600;font-size:.875rem">
        Continue
      </a>
    </div>
  </body>
</html>`);
}
