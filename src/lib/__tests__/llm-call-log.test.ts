import { beforeEach, describe, expect, it, vi } from "vitest";

// The recorder is mocked so the wrapper can be tested without opening the database — and so each
// test can assert exactly what would have been persisted.
const recorded: Array<Record<string, unknown>> = [];
vi.mock("@/lib/api-call-log", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-call-log")>();
  return {
    ...actual,
    recordApiCall: async (input: Record<string, unknown>) => {
      recorded.push(input);
      return "row-1";
    },
  };
});

const { loggingFetch } = await import("@/lib/llm-call-log");

/** Wait for the fire-and-forget record (and, for streams, the background drain) to land. */
async function settled() {
  for (let i = 0; i < 50 && recorded.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

const chatRequest = {
  method: "POST",
  body: JSON.stringify({
    model: "gpt-4o",
    messages: [{ role: "user", content: "写一条 30 秒带货脚本" }],
    temperature: 0.8,
  }),
};

beforeEach(() => {
  recorded.length = 0;
});

describe("loggingFetch", () => {
  it("hands the caller an unread body — the SDK still parses the completion", async () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 900, completion_tokens: 120 },
    });
    const wrapped = loggingFetch({ modelType: "text", scene: "script_generate" }, async () =>
      new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );

    const response = await wrapped("https://api.openai.com/v1/chat/completions", chatRequest);
    // the crucial invariant: logging must never consume what the caller needs
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: "OK" } }] });

    await settled();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      modelType: "text",
      scene: "script_generate",
      model: "gpt-4o",
      provider: "api.openai.com",
      endpoint: "/v1/chat/completions",
      status: "success",
      httpStatus: 200,
    });
    expect(recorded[0].usage).toMatchObject({ promptTokens: 900, completionTokens: 120 });
    expect((recorded[0].cost as { totalUsd: number }).totalUsd).toBeGreaterThan(0);
  });

  it("does not leak the API key from the request headers or body", async () => {
    const wrapped = loggingFetch({ modelType: "text" }, async () =>
      new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    await wrapped("https://api.openai.com/v1/chat/completions", {
      ...chatRequest,
      headers: { Authorization: "Bearer sk-secret-key" },
    });
    await settled();
    expect(JSON.stringify(recorded)).not.toContain("sk-secret-key");
  });

  it("records a failed status without swallowing the response", async () => {
    const wrapped = loggingFetch({ modelType: "text" }, async () =>
      new Response(JSON.stringify({ error: { message: "insufficient quota" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );
    const response = await wrapped("https://api.openai.com/v1/chat/completions", chatRequest);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("insufficient quota");
    await settled();
    expect(recorded[0]).toMatchObject({ status: "failed", httpStatus: 429, error: "HTTP 429" });
  });

  it("records a transport failure and still throws it to the caller", async () => {
    const wrapped = loggingFetch({ modelType: "text" }, async () => {
      throw new Error("fetch failed");
    });
    await expect(wrapped("https://api.openai.com/v1/chat/completions", chatRequest)).rejects.toThrow("fetch failed");
    await settled();
    expect(recorded[0]).toMatchObject({ status: "failed", error: "fetch failed" });
  });

  it("streams through untouched and logs the assembled answer once it ends", async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"一"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"二"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ];
    const wrapped = loggingFetch({ modelType: "text" }, async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const response = await wrapped("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    expect(await response.text()).toBe(frames.join(""));

    await settled();
    expect(recorded[0]).toMatchObject({ streamed: true, status: "success" });
    expect((recorded[0].response as { summary: string }).summary).toBe("一二");
    expect(recorded[0].usage).toMatchObject({ promptTokens: 10 });
  });

  it("upgrades a text call to vision when the messages carry an image", async () => {
    const wrapped = loggingFetch({ modelType: "text", scene: "product_analysis" }, async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await wrapped("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "分析这张商品图" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(10_000)}` } },
            ],
          },
        ],
      }),
    });
    await settled();
    expect(recorded[0].modelType).toBe("vision");
    // the base64 payload is summarized, not stored
    expect(JSON.stringify(recorded[0]).length).toBeLessThan(2000);
  });
});

describe("what the wrapper leaves alone", () => {
  it("does not record a catalog read — only calls that cost something", async () => {
    const wrapped = loggingFetch({ modelType: "text" }, async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const response = await wrapped("https://api.openai.com/v1/models", { method: "GET" });
    expect(await response.json()).toMatchObject({ data: [{ id: "gpt-4o" }] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(recorded).toHaveLength(0);
  });
});
