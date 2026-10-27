// @vitest-environment node
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { mkdtemp,readFile,writeFile,rm,readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
const state=vi.hoisted(()=>({root:"",getConfig:vi.fn()}));
vi.mock("@/lib/paths",()=>({getDataDir:()=>state.root}));
vi.mock("@/lib/server-object-storage",async original=>({...await original<object>(),requireServerObjectStorage:state.getConfig}));
import { cachedVideo,type VideoResource } from "@/lib/media-resource-cache";
const bytes=Buffer.from("verified-video-bytes");
const c={endpoint:"https://tos-s3-cn-shanghai.volces.com",region:"cn-shanghai",bucket:"test",accessKeyId:"PUBLIC-AK",secretAccessKey:"PRIVATE-SK"};
const resource:VideoResource={sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length,width:1080,height:1920,objectKey:"one.mp4",storage:{endpoint:c.endpoint,region:c.region,bucket:c.bucket,pathStyle:false}};
vi.mock("@/lib/agent-studio/resources",()=>({agentResourceFile:async()=>({file:await cachedVideo(resource),resource})}));
import { GET } from "@/app/api/agent-studio/resources/[id]/route";
beforeEach(async()=>{state.root=await mkdtemp(join(tmpdir(),"media-cache-"));state.getConfig.mockReset().mockReturnValue(c);vi.stubGlobal("fetch",vi.fn().mockImplementation(async()=>new Response(bytes)));});
afterEach(async()=>{vi.unstubAllGlobals();await rm(state.root,{recursive:true,force:true});});
describe("content-addressed video caching",()=>{
 it("coalesces parallel cache misses and serves later reads without signing or contacting TOS",async()=>{
  const paths=await Promise.all([cachedVideo(resource),cachedVideo(resource),cachedVideo({...resource,objectKey:"other.mp4"})]);expect(new Set(paths).size).toBe(1);expect(fetch).toHaveBeenCalledTimes(1);expect(state.getConfig).toHaveBeenCalledTimes(1);expect(await readFile(paths[0])).toEqual(bytes);
  state.getConfig.mockImplementation(()=>{throw new Error("offline");});expect(await cachedVideo(resource)).toBe(paths[0]);expect(fetch).toHaveBeenCalledTimes(1);
 });
 it("reuses a verified disk cache after module/process state is reset",async()=>{
  const path=await cachedVideo(resource);vi.resetModules();const again=await import("@/lib/media-resource-cache");state.getConfig.mockImplementation(()=>{throw new Error("offline");});expect(await again.cachedVideo(resource)).toBe(path);expect(fetch).toHaveBeenCalledTimes(1);
 });
 it("imports an existing local result without any object-storage request",async()=>{
  const local=join(state.root,"legacy.mp4");await writeFile(local,bytes);state.getConfig.mockImplementation(()=>{throw new Error("no credentials");});const path=await cachedVideo(resource,local);expect(await readFile(path)).toEqual(bytes);expect(fetch).not.toHaveBeenCalled();expect(state.getConfig).not.toHaveBeenCalled();
 });
 it("does not publish corrupt or oversized cloud results, and removes partial files",async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(new Response(Buffer.from("x".repeat(bytes.length))));await expect(cachedVideo(resource)).rejects.toThrow("verified");expect(await readdir(join(state.root,"cache/agent-media"))).toEqual([]);
  vi.mocked(fetch).mockResolvedValueOnce(new Response(Buffer.alloc(bytes.length+1)));await expect(cachedVideo(resource)).rejects.toThrow("verified");
 });
 it("detects modified cached bytes and fetches a verified replacement",async()=>{
  const file=await cachedVideo(resource);await writeFile(file,Buffer.from("x".repeat(bytes.length)));await cachedVideo(resource);expect(fetch).toHaveBeenCalledTimes(2);expect(await readFile(file)).toEqual(bytes);
 });
 it("rejects inconsistent storage locations and invalid identifiers before reading the cloud",async()=>{
  await expect(cachedVideo({...resource,storage:{...resource.storage,bucket:"wrong"}})).rejects.toThrow("does not match");expect(fetch).not.toHaveBeenCalled();await expect(cachedVideo({...resource,sha256:"../escape"})).rejects.toThrow("metadata");
 });
 it("serves byte ranges, downloads and conditional requests from the same cached resource",async()=>{
  const context={params:Promise.resolve({id:"request-1"})};const req=(suffix="",headers:Record<string,string>={})=>new NextRequest(`http://localhost/api/agent-studio/resources/request-1${suffix}`,{headers});
  const range=await GET(req("",{range:"bytes=0-3"}),context);expect(range.status).toBe(206);expect(Buffer.from(await range.arrayBuffer())).toEqual(bytes.subarray(0,4));expect(range.headers.get("content-range")).toBe(`bytes 0-3/${bytes.length}`);
  const download=await GET(req("?download=1"),context);expect(download.headers.get("content-disposition")).toContain("attachment");expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  expect((await GET(req("",{"if-none-match":`"${resource.sha256}"`}),context)).status).toBe(304);expect((await GET(req("",{range:"bytes=999-"}),context)).status).toBe(416);expect(fetch).toHaveBeenCalledTimes(1);
 });
});
