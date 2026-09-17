import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone output: next build additionally emits .next/standalone (minimal server.js + nft-traced dependency subset),
  // used by the Electron main process to fork-start the server without requiring npm install on the user's machine. Does not affect next dev.
  output: "standalone",
  // better-sqlite3 is a native module; mark it external (loaded via require, so the bundler won't try to bundle its .node file)
  // ffmpeg-static resolves its binary path from __dirname; bundling it would point that at .next/, so keep it external too
  // (src/lib/ffmpeg-caps.ts imports it as the fallback binary when the system ffmpeg lacks drawtext/libass)
  serverExternalPackages: ["better-sqlite3", "ffmpeg-static"],
  // Keep the file trace honest: nft's conservative directory collection was dragging the local
  // data/ (user uploads/outputs — 96MB of it), the docs site and other repo-only folders into
  // .next/standalone, which then shipped inside every desktop installer (issue: 330MB dmg).
  // data/ is a runtime-created directory (Electron uses userData anyway), never a build input.
  outputFileTracingExcludes: {
    "/**": ["./.git/**", "./.github/**", "./data/**", "./docs/**", "./tasks/**", "./release/**", "./integrations/**", "./e2e/**", "./remotion/**"],
  },
  experimental: {
    // src/proxy.ts matches /api/:path*, and a matched request has its body cloned and buffered so
    // both the proxy and the route can read it. The default 10MB ceiling silently TRUNCATES anything
    // larger — the route then fails to parse a half-delivered multipart body — which caps every
    // material upload (素材库导入 and the per-project library) far below the 80MB they advertise.
    // Sized above MATERIAL_MAX_BYTES so the multipart envelope around an 80MB file still fits and
    // the routes, not this limit, are what reject an oversized file (with a 413 that says so).
    proxyClientMaxBodySize: "96mb",
  },
};

export default nextConfig;
