import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` serves its client bundles only to localhost by default; without this, /dev/chat
  // opened at 127.0.0.1 never hydrates (the Send button stays disabled).
  allowedDevOrigins: ["127.0.0.1"],
  // At phone width the bottom-left dev indicator covers the simulator's attach button. Compile and
  // runtime errors still show without it.
  devIndicators: false,
  // The dev request logger prints full URLs; the simulator's thread poll carries the (fictional)
  // phone number in its query string, and polls every second.
  logging: { incomingRequests: { ignore: [/\/api\/dev\/sim\//] } },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
