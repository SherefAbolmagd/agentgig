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
  poweredByHeader: false,
  async headers() {
    const security = [
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
    ];
    if (process.env.NODE_ENV === "production") security.push({ key: "Content-Security-Policy", value: CSP });
    return [{ source: "/:path*", headers: security }];
  },
};

const authDomain = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "";
// Next.js inlines small scripts and styles, hence 'unsafe-inline'. Everything
// else is limited to this origin and the Firebase / Google endpoints the
// client SDK talks to.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://apis.google.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.googleusercontent.com",
  "font-src 'self' data:",
  "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com",
  `frame-src https://${authDomain} https://accounts.google.com`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export default nextConfig;
