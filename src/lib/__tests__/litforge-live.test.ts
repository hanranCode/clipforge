// @vitest-environment node
// Explicit opt-in: uploads fixtures and runs real GPU workflows. Never enabled by ordinary CI.
import { expect, it } from "vitest";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProvider } from "@/lib/providers";
import { LITFORGE_MODELS } from "@/lib/litforge/catalog";
import { requireServerObjectStorage } from "@/lib/server-object-storage";
import { uploadToObjectStorage } from "@/lib/object-storage-server";
import { probeMedia } from "@/lib/media-probe";
import { hashFile } from "@/lib/media-resource-cache";
import { litforgeOutputFile } from "@/lib/litforge/server";

it.skipIf(process.env.LITFORGE_LIVE !== "1")("verifies all three real LitForge services without resubmitting an uncertain task", async () => {
  process.loadEnvFile(".env.local");
  const path = process.env.LITFORGE_LIVE_FIXTURES;
  if (!path) throw new Error("Set LITFORGE_LIVE_FIXTURES to a private JSON file containing video, portrait and control fixture paths");
  const fixtures = JSON.parse(await readFile(path, "utf8")) as { video: string; portrait: string; control: string; reportDir: string };
  const c = requireServerObjectStorage(), provider = createProvider({ name: "litforge", apiKey: "", baseUrl: "", logContext: { scene: "litforge_verification" } });
  const image = await uploadToObjectStorage(c, fixtures.portrait);
  const source = await uploadToObjectStorage(c, fixtures.video);
  const control = await uploadToObjectStorage(c, fixtures.control);
  await mkdir(fixtures.reportDir, { recursive: true, mode: 0o700 });
  const report: unknown[] = [];
  for (const options of [
    { modelId: LITFORGE_MODELS.replace, referenceVideoUrls: [source], referenceImageUrls: [image], duration: 77 / 30 },
    { modelId: LITFORGE_MODELS.reference, referenceVideoUrls: [control], referenceImageUrls: [image], duration: 1 },
    { modelId: LITFORGE_MODELS.upscale, referenceVideoUrls: [source] },
  ]) {
    const { taskId } = await provider.submitVideoTask!({ ...options, mode: "video-to-video", prompt: "A single person moves naturally in the original scene.", width: 832, height: 480, seed: 42 });
    // Checkpoint before polling. A timeout preserves this handle for a query-only recovery.
    report.push({ taskId, model: options.modelId, status: "submitted" });
    await writeFile(join(fixtures.reportDir, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    let state = await provider.getTaskStatus(taskId);
    const deadline = Date.now() + 15 * 60_000;
    while (!["completed", "failed", "cancelled"].includes(state.status) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 15_000));
      state = await provider.getTaskStatus(taskId);
    }
    expect(state.status).toBe("completed");
    if (!state.result || !("videoUrls" in state.result)) throw new Error("Missing video result");
    const file = litforgeOutputFile(state.result.videoUrls[0]);
    if (!file) throw new Error("Missing local output");
    const media = await probeMedia(file), sha256 = await hashFile(file);
    expect(media.width).toBeGreaterThan(0); expect(media.duration).toBeGreaterThan(0);
    expect(sha256).toBe(state.result.extra?.sha256);
    report[report.length - 1] = { taskId, model: options.modelId, status: state.status, file, sha256, media, verifiedAt: new Date().toISOString() };
    await writeFile(join(fixtures.reportDir, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
}, 50 * 60_000);
