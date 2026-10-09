// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { VolcEngineProvider } from "@/lib/providers/volcengine";
import { buildImageOptions } from "@/lib/gen-params";

afterEach(() => {
  vi.restoreAllMocks();
});

it("按方舟图片协议发送多张参考图，并丢弃历史设置里的空 seed", async () => {
  let requestBody: Record<string, unknown> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ data: [{ url: "https://cdn.example.com/grid.png" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );

  const provider = new VolcEngineProvider({ name: "volcengine", apiKey: "test-key", baseUrl: "http://ark.test/v3" });
  const result = await provider.generateImage({
    modelId: "doubao-seedream-4-0-250828",
    mode: "image-to-image",
    prompt: "3x3 storyboard",
    width: 1080,
    height: 1920,
    referenceImageUrls: ["data:image/png;base64,one", "data:image/png;base64,two"],
    seed: "" as unknown as number,
    extra: { seed: "" },
  });

  expect(result.imageUrls).toEqual(["https://cdn.example.com/grid.png"]);
  expect(requestBody).toMatchObject({
    model: "doubao-seedream-4-0-250828",
    size: "2K",
    image: ["data:image/png;base64,one", "data:image/png;base64,two"],
  });
  expect(requestBody).not.toHaveProperty("seed");
});

it("构造图片参数时清洗旧版本持久化的空数字", () => {
  const options = buildImageOptions({
    aspectRatio: "9:16",
    count: "" as unknown as number,
    steps: "" as unknown as number,
    guidanceScale: Number.NaN,
    seed: "" as unknown as number,
  });

  expect(options).toMatchObject({ width: 1080, height: 1920, count: 1 });
  expect(options).not.toHaveProperty("steps");
  expect(options).not.toHaveProperty("guidanceScale");
  expect(options).not.toHaveProperty("seed");
});
