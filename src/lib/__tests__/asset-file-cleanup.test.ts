import { describe, it, expect } from "vitest";
import { isOwnedTakeFile, takeFilesToDelete } from "@/lib/asset-file-cleanup";

const P = "proj1";

describe("isOwnedTakeFile（只认本 take 自己生成的文件）", () => {
  it("persistAssetSource 生成的命名 → 可删", () => {
    expect(isOwnedTakeFile(P, "/api/files/proj1/asset-3-1716900000000-a1b2c3d4.png")).toBe(true);
    expect(isOwnedTakeFile(P, "/api/files/proj1/repair-12-1716900000000-0f9e8d7c.mp4")).toBe(true);
  });

  it("商品图 / 普通上传（两段式命名）→ 不可删，它们被项目和别的分镜共用", () => {
    expect(isOwnedTakeFile(P, "/api/files/proj1/1716900000000-ab12cd.jpg")).toBe(false);
  });

  it("本地素材库文件（materials 子目录）→ 不可删", () => {
    expect(isOwnedTakeFile(P, "/api/files/proj1/materials/asset-3-1716900000000-a1b2c3d4.mp4")).toBe(false);
  });

  it("其他项目目录 / 远程地址 / 空值 → 不可删", () => {
    expect(isOwnedTakeFile(P, "/api/files/other/asset-3-1716900000000-a1b2c3d4.png")).toBe(false);
    expect(isOwnedTakeFile(P, "https://cdn/asset-3-1716900000000-a1b2c3d4.png")).toBe(false);
    expect(isOwnedTakeFile(P, null)).toBe(false);
    expect(isOwnedTakeFile(P, undefined)).toBe(false);
    expect(isOwnedTakeFile("", "/api/files//asset-3-1-a1b2c3d4.png")).toBe(false);
  });
});

describe("takeFilesToDelete（删 take 时该 unlink 哪些文件）", () => {
  const clip = "/api/files/proj1/asset-3-1716900000000-a1b2c3d4.mp4";
  const keyframe = "/api/files/proj1/asset-3-1716800000000-11223344.png";
  const productPhoto = "/api/files/proj1/1716000000000-ab12cd.jpg";

  it("被删 take 的成片与关键帧都回收", () => {
    expect(takeFilesToDelete(P, [{ filePath: clip, thumbnailPath: keyframe }], [])).toEqual([clip, keyframe]);
  });

  it("仍被存活 take 引用的文件不动（关键帧常被图片 take 与 i2v take 共用）", () => {
    const survivors = [{ filePath: keyframe, thumbnailPath: null }];
    expect(takeFilesToDelete(P, [{ filePath: clip, thumbnailPath: keyframe }], survivors)).toEqual([clip]);
  });

  it("共用型文件（商品图/上传件）永远不删，哪怕没人再引用它", () => {
    expect(takeFilesToDelete(P, [{ filePath: productPhoto }], [])).toEqual([]);
  });

  it("多个 take 指向同一文件时只回收一次", () => {
    expect(takeFilesToDelete(P, [{ filePath: clip }, { filePath: clip, thumbnailPath: clip }], [])).toEqual([clip]);
  });
});
