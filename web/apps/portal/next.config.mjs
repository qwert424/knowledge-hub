/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@kh/api-client', '@kh/ui'],
  experimental: {
    optimizePackageImports: ['antd', '@ant-design/icons'],
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
