/** @type {import('next').NextConfig} */
const renderApiUrl = (process.env.RENDER_API_URL ?? (process.env.NODE_ENV === "development" ? "http://localhost:5000" : "https://fitzone-api.onrender.com")).replace(/\/+$/, "");

if (renderApiUrl) {
  const apiUrl = new URL(renderApiUrl);
  if (process.env.NODE_ENV === "production" && apiUrl.protocol !== "https:") {
    throw new Error("RENDER_API_URL must use HTTPS in production.");
  }
  if (apiUrl.origin !== renderApiUrl) {
    throw new Error("RENDER_API_URL must be an origin without a path or trailing slash.");
  }
}

const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  transpilePackages: ["@fitzone/shared"],
  async rewrites() {
    if (!renderApiUrl) return [];
    return [{ source: "/api/:path*", destination: `${renderApiUrl}/api/:path*` }];
  },
};

export default nextConfig;
