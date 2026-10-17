/** Local identity is stable; the access URL is refreshed whenever media is submitted. */
export interface ReferenceResource {
  id: string;
  md5: string;
  mediaType: "image" | "video" | "audio";
  label: string;
  path: string;
  url: string;
  objectUrl: string;
  objectKey: string;
  bucket: string;
  endpoint: string;
  expiresAt: string;
}
