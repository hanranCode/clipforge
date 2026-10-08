import { describe, it, expect } from "vitest";
import { isObjectStorageConfigured, type ObjectStorageConfig } from "@/lib/object-storage";
import { objectKeyFor, objectLocation, presignUrl } from "@/lib/object-storage-server";

// AWS SigV4 documentation example ("Example: a presigned URL for GET"), whose published
// signature is aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404
const aws: ObjectStorageConfig = {
  endpoint: "https://s3.amazonaws.com",
  region: "us-east-1",
  bucket: "examplebucket",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

describe("object-storage", () => {
  it("matches the AWS SigV4 presigned-GET reference signature", () => {
    const url = presignUrl(aws, { method: "GET", key: "test.txt", expiresSeconds: 86400, now: new Date("2013-05-24T00:00:00Z") });
    expect(url.startsWith("https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256")).toBe(true);
    expect(url).toContain("X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request");
    expect(url.endsWith("X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404")).toBe(true);
  });

  it("puts the bucket in the path when path-style is on, and encodes keys", () => {
    const loc = objectLocation({ ...aws, endpoint: "http://127.0.0.1:9000/", pathStyle: true }, "a b/视频.mp4");
    expect(loc.host).toBe("127.0.0.1:9000");
    expect(loc.path).toBe("/examplebucket/a%20b/%E8%A7%86%E9%A2%91.mp4");
  });

  it("prefixes keys and keeps the extension", () => {
    expect(objectKeyFor({ ...aws, prefix: "clipforge" }, "seg-1.mp4")).toMatch(/^clipforge\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+\.mp4$/);
  });

  it("requires every connection field", () => {
    expect(isObjectStorageConfigured(aws)).toBe(true);
    expect(isObjectStorageConfigured({ ...aws, bucket: " " })).toBe(false);
    expect(isObjectStorageConfigured(null)).toBe(false);
  });
});
