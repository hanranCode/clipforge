import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LITFORGE_MODELS, litforgeCapability, type LitforgeCapability } from "@/lib/litforge/catalog";

const exec = promisify(execFile);
export function aiNodesConfigured() {
  return ["TEMPORAL_ADDRESS", "TEMPORAL_SERVER_CA", "TEMPORAL_CLIENT_CERT", "TEMPORAL_CLIENT_KEY", "AI_NODES_PAYLOAD_KEY_FILE"].every(k => Boolean(process.env[k]?.trim()));
}
/** Use the upstream CLI so mTLS, encrypted payloads and failure attributes use its exact codec. */
export async function callAiNodes(command: "submit" | "status" | "result" | "cancel" | "set-output", workflowId: string, payload?: unknown, capability: LitforgeCapability = litforgeCapability(LITFORGE_MODELS.upscale)): Promise<Record<string, unknown>> {
  if (!aiNodesConfigured()) throw new Error("请先配置 AI Nodes 的 Temporal 连接与私密证书 / Configure AI Nodes credentials first");
  let dir: string | undefined;
  try {
    const args: string[] = [command];
    if (payload !== undefined) {
      dir = await mkdtemp(join(tmpdir(), "clipforge-ai-nodes-"));
      await chmod(dir, 0o700);
      const file = join(dir, "request.json");
      await writeFile(file, JSON.stringify(payload), { mode: 0o600 });
      if (command === "set-output") args.push(workflowId, "--destination", file);
      else args.push("--request", file);
    } else args.push(workflowId);
    const env = { ...process.env };
    // Never let the old global SR queue route a new capability to the wrong Worker.
    if (capability) {
      if (command === "submit") args.push("--capability", capability.cli);
      env.TEMPORAL_TASK_QUEUE = process.env[`LITFORGE_${capability.cli.toUpperCase().replace(/-/g, "_")}_QUEUE`] || (capability.cli === "media-sr" ? process.env.TEMPORAL_TASK_QUEUE : undefined) || capability.queue;
    }
    const { stdout } = await exec(process.env.AI_NODES_CLI || "ai-nodes", args, { timeout: 45_000, maxBuffer: 256_000, windowsHide: true, env });
    if (command === "cancel" || command === "set-output") return {};
    const value: unknown = JSON.parse(stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid response");
    return value as Record<string, unknown>;
  } catch {
    // CLI errors/stdout may contain signed URLs or secret paths. Never return them to UI/logs.
    throw new Error("AI Nodes 调用未确认，请查询原任务或检查服务端配置 / AI Nodes call unconfirmed; query the existing task or check server configuration");
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
