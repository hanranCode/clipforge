// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { callAiNodes, aiNodesConfigured } from "@/lib/agent-studio/ai-nodes-client";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ai-nodes-cli-test-"));
  for (const key of ["TEMPORAL_ADDRESS", "TEMPORAL_SERVER_CA", "TEMPORAL_CLIENT_CERT", "TEMPORAL_CLIENT_KEY", "AI_NODES_PAYLOAD_KEY_FILE"]) vi.stubEnv(key, "test");
  vi.stubEnv("AI_NODES_CLI", join(dir, "fake-ai-nodes"));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
it("uses private request files and removes them after CLI completion", async () => {
  await writeFile(process.env.AI_NODES_CLI!, `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.argv.at(-1), dir = require('node:path').dirname(file);
const request = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(JSON.stringify({file, fileMode: fs.statSync(file).mode & 511, dirMode: fs.statSync(dir).mode & 511, request, args: process.argv.slice(2, 4)}));
`, { mode: 0o700 });
  const result = await callAiNodes("submit", "unused", { output: { put_url: "https://example.com?secret" } });
  expect(result.fileMode).toBe(0o600); expect(result.dirMode).toBe(0o700); expect(result.args).toEqual(["submit", "--request"]);
  await expect(access(result.file as string)).rejects.toThrow();
});
it("sanitizes subprocess stderr and malformed stdout", async () => {
  await writeFile(process.env.AI_NODES_CLI!, '#!/usr/bin/env node\nconsole.error("signed-secret-url"); process.exit(1);', { mode: 0o700 });
  await expect(callAiNodes("status", "media-sr-test")).rejects.toThrow("AI Nodes call unconfirmed");
  try { await callAiNodes("status", "media-sr-test"); } catch (e) { expect(String(e)).not.toContain("signed-secret-url"); }
  await writeFile(process.env.AI_NODES_CLI!, '#!/usr/bin/env node\nconsole.log("not-json-secret");', { mode: 0o700 });
  await expect(callAiNodes("result", "media-sr-test")).rejects.toThrow("AI Nodes call unconfirmed");
});
it("requires configured private credentials", async () => {
  vi.stubEnv("AI_NODES_PAYLOAD_KEY_FILE", ""); expect(aiNodesConfigured()).toBe(false);
  await expect(callAiNodes("status", "media-sr-test")).rejects.toThrow("credentials first");
});
