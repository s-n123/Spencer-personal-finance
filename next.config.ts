import { networkInterfaces } from "node:os";
import type { NextConfig } from "next";

/**
 * This machine's IPv4 LAN addresses, so /dev/chat opened from a phone at http://<LAN IP>:3000
 * hydrates after `npm run dev -- -H 0.0.0.0`. Harmless under the default 127.0.0.1 bind, where
 * nothing off the machine can connect (D-144). Not covered: <hostname>.local and IPv6.
 */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .flatMap((a) => (a && a.family === "IPv4" && !a.internal ? [a.address] : []));
}

const nextConfig: NextConfig = {
  // `next dev` serves its client bundles only to localhost by default; without this, /dev/chat
  // opened at 127.0.0.1 (or a LAN IP) never hydrates (the Send button stays disabled).
  allowedDevOrigins: ["127.0.0.1", ...lanAddresses()],
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
