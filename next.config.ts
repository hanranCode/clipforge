import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone output: next build additionally emits .next/standalone (minimal server.js + nft-traced dependency subset),
  // used by the Electron main process to fork-start the server without requiring npm install on the user's machine. Does not affect next dev.
  output: "standalone",
  // `next build` clears the whole dist directory, and `next dev` keeps its own state inside the very
  // same one (.next/dev in Next 16). Building while a dev server is running therefore deletes the
  // files that server is still holding open, and it degrades into ENOENT on every request — with a
  // restart the only way out. Setting CLIPFORGE_DIST_DIR gives a verification or CI build its own
  // directory so it cannot reach into a running dev server's. Unset, nothing changes.
  // Caveat: next build appends the active dist directory's type globs to tsconfig.json, so a build
  // run this way leaves `.next-<name>/types/**` behind in it — discard that hunk, it is throwaway.
  distDir: process.env.CLIPFORGE_DIST_DIR || ".next",
  // better-sqlite3 is a native module; mark it external (loaded via require, so the bundler won't try to bundle its .node file)
  serverExternalPackages: ["better-sqlite3"],
  // Keep the file trace honest: nft's conservative directory collection was dragging the local
  // data/ (user uploads/outputs — 96MB of it), the docs site and other repo-only folders into
  // .next/standalone, which then shipped inside every desktop installer (issue: 330MB dmg).
  // data/ is a runtime-created directory (Electron uses userData anyway), never a build input.
  outputFileTracingExcludes: {
    "/**": ["./.git/**", "./.github/**", "./data/**", "./docs/**", "./tasks/**", "./release/**", "./integrations/**", "./e2e/**", "./remotion/**"],
  },
};

export default nextConfig;
