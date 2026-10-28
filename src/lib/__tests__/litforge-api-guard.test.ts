// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/providers", () => ({ createProvider: vi.fn() }));
vi.mock("@/lib/ai-tasks", () => ({ conflictingAiTaskProvider: vi.fn(async () => undefined), updateAiTaskByProviderTaskId: vi.fn(), recordAiTask: vi.fn(), updateAiTask: vi.fn() }));
import { createProvider } from "@/lib/providers";
import { POST as generate } from "@/app/api/ai/video/route";
import { POST as query } from "@/app/api/ai/video/task/route";
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createProvider).mockReturnValue({ name: "litforge", generateVideo: vi.fn(async () => ({ taskId: "task", modelId: "litforge/media-sr-v1", videoUrls: ["/api/output/litforge/test.mp4"] })), getTaskStatus: vi.fn(async () => ({ taskId: "task", status: "processing" })) } as unknown as ReturnType<typeof createProvider>);
});
it.each([generate, query])("rejects cross-origin keyless requests before using server Caller credentials", async route => {
  const response = await route(new NextRequest("http://localhost/api/ai/video", { method: "POST", headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site", "content-type": "text/plain" }, body: JSON.stringify({ provider: "litforge", model: "litforge/media-sr-v1", taskId: "task", referenceVideoUrls: ["https://attacker.example/input.mp4"] }) }));
  expect(response.status).toBe(403); expect(createProvider).not.toHaveBeenCalled();
});
it("allows the local application to use its registered Litforge provider without a browser API key", async () => {
  const response = await generate(new NextRequest("http://localhost/api/ai/video", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ provider: "litforge", model: "litforge/media-sr-v1", mode: "video-to-video", referenceVideoUrls: ["https://input.example/video.mp4"] }) }));
  expect(response.status).toBe(200); expect(createProvider).toHaveBeenCalledWith(expect.objectContaining({ name: "litforge" }));
});
