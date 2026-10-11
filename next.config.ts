import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle for the Cloud Run container.
  output: "standalone",
  // Google's gRPC clients break when bundled; load them from node_modules.
  serverExternalPackages: [
    "@google-cloud/dlp",
    "@google-cloud/storage",
    "@google-cloud/secret-manager",
    "@google-cloud/tasks",
    "google-gax",
    "firebase-admin",
  ],
  // The standalone tracer misses the JSON client configs and protos these
  // libraries load at runtime (e.g. cloud_tasks_client_config.json).
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/@google-cloud/*/build/**/*.json", "./node_modules/@google-cloud/*/build/protos/**/*"],
  },
};

export default nextConfig;
