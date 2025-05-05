/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  distDir: 'out-static',
  images: {
    domains: [
      'lh3.googleusercontent.com',  // Google profile pictures
      'platform-lookaside.fbsbx.com', // Facebook profile pictures
      'graph.facebook.com'  // Alternative Facebook CDN
    ],
    dangerouslyAllowSVG: true,
    contentDispositionType: 'attachment',
    contentSecurityPolicy: "default-src 'self'; script-src 'none'; sandbox;",
    unoptimized: true, // Required for static export
  }
};

module.exports = nextConfig; 