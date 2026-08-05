import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This demo has no server data or authenticated calls. Export every route so
  // the public product is served as immutable assets instead of depending on a
  // request-time render worker.
  output: "export",
};

export default nextConfig;
