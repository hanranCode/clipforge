import { describe, expect, it, vi } from "vitest";

describe("API call sink across server module contexts", () => {
  it("keeps the installed writer when the log module is evaluated again", async () => {
    vi.resetModules();
    const first = await import("@/lib/api-call-log");
    const record = vi.fn(async () => "row-1");
    first.setApiCallSink({ record, update: async () => {} });

    vi.resetModules();
    const second = await import("@/lib/api-call-log");
    try {
      const rowId = await second.recordApiCall({
        modelType: "image", provider: "volcengine", model: "clipforge-log-probe",
      });
      expect(rowId).toBe("row-1");
      expect(record).toHaveBeenCalledOnce();
    } finally {
      second.setApiCallSink({ record: async () => null, update: async () => {} });
      vi.resetModules();
    }
  });

  it("records a two-phase Seedance video at submission and updates it on completion", async () => {
    vi.resetModules();
    const { setApiCallSink } = await import("@/lib/api-call-log");
    const { withApiLogging } = await import("@/lib/providers/logged-provider");
    const { VolcEngineProvider } = await import("@/lib/providers/volcengine");
    const record = vi.fn(async () => "video-row");
    const update = vi.fn(async () => {});
    setApiCallSink({ record, update });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) =>
      new Response(JSON.stringify(init?.method === "POST"
        ? { id: "task-1" }
        : { id: "task-1", status: "succeeded", content: { video_url: "https://example.com/video.mp4" } }), { status: 200 })
    ));
    try {
      const provider = withApiLogging(new VolcEngineProvider({ name: "volcengine", apiKey: "test-key", baseUrl: "" }));
      const submitted = await provider.submitVideoTask!({
        modelId: "doubao-seedance-2-0-mini-260615", mode: "text-to-video", prompt: "test", duration: 4,
      });
      expect(submitted.taskId).toBe("task-1");
      expect(record).toHaveBeenCalledWith(expect.objectContaining({
        modelType: "video", model: "doubao-seedance-2-0-mini-260615",
        endpoint: "submitVideoTask", taskId: "task-1", status: "success",
      }));
      await provider.waitForTask!(submitted.taskId);
      expect(update).toHaveBeenCalledWith("video-row", expect.objectContaining({ status: "success" }));
    } finally {
      setApiCallSink({ record: async () => null, update: async () => {} });
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
