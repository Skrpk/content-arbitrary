import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `postgres` (postgres.js) uses Node APIs; keep it external so Next does not
  // try to bundle it into the serverless function bundle.
  serverExternalPackages: ['postgres'],
};

export default nextConfig;
