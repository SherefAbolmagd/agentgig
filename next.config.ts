import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Cloud Run container.
  output: "standalone",
  // Google's gRPC clients break when bundled; load them from node_modules.
  serverExternalPackages: ["@google-cloud/dlp", "@google-cloud/storage", "google-gax", "firebase-admin"],
};

export default nextConfig;
