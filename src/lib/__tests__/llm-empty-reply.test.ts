import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import { completeWithJsonRetry, extractJSON, JSON_CALL_MAX_TOKENS } from "@/lib/script-engine/generator";
import { LLMRequestError } from "@/lib/llm-error";

/** Minimal stand-in for the OpenAI client: replays a scripted list of chat replies. */
function fakeClient(replies: unknown[]) {
  const sent: { messages: { role: string; content: unknown }[] }[] = [];
  const client = {
    chat: {
      completions: {
        create: async (params: { messages: { role: string; content: unknown }[] }) => {
          sent.push({ messages: params.messages });
          const next = replies[sent.length - 1];
          if (next === undefined) throw new Error("多调用了一次 LLM");
          return next;
        },
      },
    },
  } as unknown as OpenAI;
  return { client, sent };
}

const reply = (over: Record<string, unknown>) => ({
  choices: [{ message: { content: null, ...(over.message as object) }, finish_reason: over.finish_reason ?? "stop" }],
});

const CFG = { baseUrl: "https://example.test/v1", apiKey: "k", model: "m" };
const PARAMS = {
  model: "m",
  max_tokens: JSON_CALL_MAX_TOKENS,
  messages: [
    { role: "system" as const, content: "你是编导" },
    { role: "user" as const, content: "写一镜" },
  ],
};

const parse = (c: string) => JSON.parse(c) as { voiceover: string };

describe("completeWithJsonRetry：空回复（思考型模型把预算烧光的那一类失败）", () => {
  it("空内容先重问一次，成功就照常返回——不再一次就报错", async () => {
    const { client, sent } = fakeClient([
      reply({ message: { content: "" }, finish_reason: "length" }),
      reply({ message: { content: '{"voiceover":"第二次写出来了"}' } }),
    ]);
    const out = await completeWithJsonRetry(client, PARAMS, CFG, parse);
    expect(out.voiceover).toBe("第二次写出来了");
    expect(sent).toHaveLength(2);
  });

  it("重问时把「只输出 JSON、不要思考过程」并进最后一条 user，而不是再追加一条 user", async () => {
    const { client, sent } = fakeClient([
      reply({ message: { content: null }, finish_reason: "length" }),
      reply({ message: { content: '{"voiceover":"好"}' } }),
    ]);
    await completeWithJsonRetry(client, PARAMS, CFG, parse);
    const second = sent[1].messages;
    expect(second).toHaveLength(PARAMS.messages.length); // 没有多出一条消息
    expect(second[second.length - 1].role).toBe("user");
    expect(String(second[second.length - 1].content)).toContain("写一镜"); // 原文还在
    expect(String(second[second.length - 1].content)).toContain("不要输出思考过程");
  });

  it("两次都空 → 报出可执行的原因，而不是「LLM 未返回有效内容」", async () => {
    const { client } = fakeClient([
      reply({ message: { content: "" }, finish_reason: "length" }),
      reply({ message: { content: "" }, finish_reason: "length" }),
    ]);
    const err = await completeWithJsonRetry(client, PARAMS, CFG, parse).catch((e) => e);
    expect(err).toBeInstanceOf(LLMRequestError);
    expect(err.zh).toContain("思考过程");
    expect(err.zh).toContain(String(JSON_CALL_MAX_TOKENS));
    expect(err.en).toContain("non-thinking");
    expect(err.zh).not.toBe("LLM 未返回有效内容");
  });

  it("非 length 的空回复给另一套说法（不是预算问题就别甩锅给预算）", async () => {
    const { client } = fakeClient([
      reply({ message: { content: "" }, finish_reason: "content_filter" }),
      reply({ message: { content: "" }, finish_reason: "content_filter" }),
    ]);
    const err = await completeWithJsonRetry(client, PARAMS, CFG, parse).catch((e) => e);
    expect(err.zh).toContain("content_filter");
    expect(err.zh).not.toContain("思考过程");
  });

  it("choices 为空数组也走同一条可读错误，而不是 undefined 崩在解析里", async () => {
    const { client } = fakeClient([{ choices: [] }, { choices: [] }]);
    const err = await completeWithJsonRetry(client, PARAMS, CFG, parse).catch((e) => e);
    expect(err).toBeInstanceOf(LLMRequestError);
  });

  it("答案落在 reasoning_content 里时直接救回来，不浪费第二次调用", async () => {
    const { client, sent } = fakeClient([
      reply({ message: { content: "", reasoning_content: '嗯我想想……{"voiceover":"藏在思考里"}' } }),
    ]);
    const out = await completeWithJsonRetry(client, PARAMS, CFG, (c) => parse(extractJSON(c)));
    expect(out.voiceover).toBe("藏在思考里");
    expect(sent).toHaveLength(1);
  });

  it("解析失败仍走原来的「把报错回灌给模型」重试，不受空回复分支影响", async () => {
    const { client, sent } = fakeClient([
      reply({ message: { content: "这不是 JSON" } }),
      reply({ message: { content: '{"voiceover":"修好了"}' } }),
    ]);
    const out = await completeWithJsonRetry(client, PARAMS, CFG, parse);
    expect(out.voiceover).toBe("修好了");
    expect(sent[1].messages).toHaveLength(PARAMS.messages.length + 2); // assistant + user 回灌
    expect(String(sent[1].messages[sent[1].messages.length - 1].content)).toContain("无法解析");
  });
});
