// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NextRequest } from "next/server";
const state = vi.hoisted(() => ({ root: "" }));
vi.mock("@/lib/paths", () => ({ getDataDir: () => state.root }));
import { getServerObjectStorage, requireServerObjectStorage } from "@/lib/server-object-storage";
import { GET } from "@/app/api/storage/local/route";
import { POST } from "@/app/api/storage/test/route";
const c = { endpoint:"https://tos-s3-cn-shanghai.volces.com",region:"cn-shanghai",bucket:"test",accessKeyId:"PRIVATE-AK",secretAccessKey:"PRIVATE-SK" };
beforeEach(async()=>{state.root=await mkdtemp(join(tmpdir(),"local-storage-"));for(const k of ["CLIPFORGE_OBJECT_STORAGE_FILE","TOS_ENDPOINT","TOS_REGION","TOS_BUCKET","TOS_ACCESS_KEY_ID","TOS_SECRET_ACCESS_KEY"])vi.stubEnv(k,"");await mkdir(join(state.root,"private"));});
afterEach(async()=>{vi.unstubAllEnvs();await rm(state.root,{recursive:true,force:true});});
it("loads only host-provisioned private config and exposes no credentials over HTTP",async()=>{
 await writeFile(join(state.root,"private/object-storage.json"),JSON.stringify(c),{mode:0o600});expect(getServerObjectStorage()).toEqual(c);
 const response=await GET(new NextRequest("http://localhost/api/storage/local"));const data=await response.json();expect(data.configured).toBe(true);expect(data.destination.bucket).toBe("test");expect(JSON.stringify(data)).not.toMatch(/PRIVATE-AK|PRIVATE-SK|accessKeyId|secretAccessKey/);
});
it("supports server environment configuration without a credential upload endpoint",()=>{
 for(const [k,v] of Object.entries({TOS_ENDPOINT:c.endpoint,TOS_REGION:c.region,TOS_BUCKET:c.bucket,TOS_ACCESS_KEY_ID:c.accessKeyId,TOS_SECRET_ACCESS_KEY:c.secretAccessKey}))vi.stubEnv(k,v);
 expect(requireServerObjectStorage()).toMatchObject(c);
});
it("fails closed on missing, malformed and broadly readable credential files",async()=>{
 expect(getServerObjectStorage()).toBeNull();expect(()=>requireServerObjectStorage()).toThrow("local server");
 const f=join(state.root,"private/object-storage.json");await writeFile(f,JSON.stringify(c),{mode:0o600});await chmod(f,0o644);expect(getServerObjectStorage()).toBeNull();await chmod(f,0o600);await writeFile(f,"invalid");expect(getServerObjectStorage()).toBeNull();
});
it("rejects non-loopback status reads",async()=>{expect((await GET(new NextRequest("https://untrusted.example/api/storage/local"))).status).toBe(403);});
it("rejects credential-bearing or invalid storage test bodies before any network operation",async()=>{
 for(const payload of [c,{objectStorage:c},null,[]]) {
  const response=await POST(new NextRequest("http://localhost/api/storage/test",{method:"POST",body:JSON.stringify(payload)}));
  expect(response.status).toBe(400);expect(await response.text()).not.toMatch(/PRIVATE-AK|PRIVATE-SK/);
 }
});
