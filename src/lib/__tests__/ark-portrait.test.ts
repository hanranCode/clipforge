import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeAssetsBySource,
  isSessionLive,
  mergeAssetStatus,
  parseAssetId,
  parseGroupId,
  substituteArkAssets,
  type ArkPortrait,
} from "@/lib/ark-portrait";
import { createVirtualGroup, getValidateResult, listPortraitGroups, signArkRequest } from "@/lib/ark-portrait-server";
import { buildPortraitShotPrompt } from "@/lib/character-sheet";

afterEach(() => vi.unstubAllGlobals());

describe("Ark portrait library — signing", () => {
  it("matches the signature @volcengine/openapi's Signer produces for the same request", () => {
    const body = JSON.stringify({ ProjectName: "default", Filter: { GroupType: "LivenessFace" } });
    const { url, headers } = signArkRequest(
      { accessKeyId: "AKLTtest", secretAccessKey: "c2VjcmV0", region: "cn-beijing" },
      "ListAssetGroups",
      body,
      new Date("2026-10-08T09:30:00Z"),
    );
    expect(url).toBe("https://ark.cn-beijing.volcengineapi.com/?Action=ListAssetGroups&Version=2024-01-01");
    expect(headers["X-Date"]).toBe("20261008T093000Z");
    // reference value computed with @volcengine/openapi 1.30.1 (lib/base/sign.js)
    expect(headers.Authorization).toBe(
      "HMAC-SHA256 Credential=AKLTtest/20261008/cn-beijing/ark/request, SignedHeaders=host;x-content-sha256;x-date, Signature=d58b1b2de56268e9aad8d1c585cffec6dc78adbe8b63d376a596b5f257db2f22",
    );
  });

  it("reads a pending liveness check as null and surfaces real errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ResponseMetadata: { Error: { Code: "NotFound.BytedToken", Message: "not found" } } }), { status: 404 })));
    await expect(getValidateResult({ accessKeyId: "a", secretAccessKey: "b" }, "tok")).resolves.toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ResponseMetadata: { Error: { Code: "InvalidCredential", Message: "bad" } } }), { status: 401 })));
    await expect(getValidateResult({ accessKeyId: "a", secretAccessKey: "b" }, "tok")).rejects.toThrow(/InvalidCredential/);
  });
});

describe("Ark portrait library — presenter assets", () => {
  const portrait = (assets: ArkPortrait["assets"]): { arkPortrait: ArkPortrait } => ({ arkPortrait: { groupId: "group-1", assets } });
  const at = "2026-10-08T00:00:00Z";

  it("swaps only photos with an Active image asset for asset://", () => {
    const map = activeAssetsBySource([
      portrait([
        { id: "asset-a", type: "Image", status: "Active", sourceUrl: "/api/files/p/a.png", createdAt: at },
        { id: "asset-b", type: "Image", status: "Processing", sourceUrl: "/api/files/p/b.png", createdAt: at },
        { id: "asset-c", type: "Image", status: "Active", createdAt: at },
      ]),
    ]);
    expect(substituteArkAssets(["/api/files/p/a.png", "/api/files/p/b.png", "/api/files/product.png"], map)).toEqual([
      "asset://asset-a",
      "/api/files/p/b.png",
      "/api/files/product.png",
    ]);
  });

  it("merges a status read without losing the photo link, and adds assets found in the group", () => {
    const merged = mergeAssetStatus(
      [{ id: "asset-a", type: "Image", status: "Processing", sourceUrl: "/api/files/a.png", createdAt: at }],
      [{ id: "asset-a", status: "Failed", error: "face mismatch" }, { id: "asset-z", status: "Active", type: "Image" }],
    );
    expect(merged[0]).toMatchObject({ id: "asset-a", status: "Failed", error: "face mismatch", sourceUrl: "/api/files/a.png" });
    expect(merged[1]).toMatchObject({ id: "asset-z", status: "Active" });
  });

  it("parses IDs and session lifetime", () => {
    expect(parseAssetId("asset://asset-20260318035710-kctzf")).toBe("asset-20260318035710-kctzf");
    expect(parseAssetId("https://x/asset-1")).toBeNull();
    expect(parseGroupId(" group-20260318033332-abc ")).toBe("group-20260318033332-abc");
    expect(isSessionLive({ h5Link: "x", bytedToken: "t", createdAt: new Date(Date.now() - 10 * 60_000).toISOString() })).toBe(true);
    expect(isSessionLive({ h5Link: "x", bytedToken: "t", createdAt: new Date(Date.now() - 40 * 60_000).toISOString() })).toBe(false);
  });
});

describe("Ark portrait library — AI virtual portraits", () => {
  const creds = { accessKeyId: "a", secretAccessKey: "b", projectName: "cv1-test" };

  it("creates an AIGC group in the configured project and lists groups by kind", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ Result: url.includes("CreateAssetGroup") ? { Id: "group-20261008-v" } : { Items: [{ Id: "group-1", Name: "小美" }] } }));
    }));
    await expect(createVirtualGroup(creds, { name: "小美", description: "AI 主播" })).resolves.toBe("group-20261008-v");
    expect(calls[0].url).toContain("Action=CreateAssetGroup");
    expect(calls[0].body).toEqual({ ProjectName: "cv1-test", Name: "小美", Description: "AI 主播", GroupType: "AIGC" });
    await expect(listPortraitGroups(creds, "virtual")).resolves.toEqual([{ id: "group-1", name: "小美" }]);
    expect(calls[1].body.Filter).toEqual({ GroupType: "AIGC" });
    await listPortraitGroups(creds);
    expect(calls[2].body.Filter).toEqual({ GroupType: "LivenessFace" });
  });

  it("asks for the two recommended single-person vertical shots", () => {
    const full = buildPortraitShotPrompt("25岁女生，齐肩短发，白色针织衫", "fullBody", { name: "小美", fromSheet: true });
    expect(full).toContain("正面全身");
    expect(full).toContain("以参考图中的人物为准");
    expect(full).toContain("不与任何真实人物或名人雷同");
    const face = buildPortraitShotPrompt("a woman in her 20s with short hair", "faceCloseup");
    expect(face).toContain("shoulders up");
    expect(face).not.toContain("reference image");
  });
});
