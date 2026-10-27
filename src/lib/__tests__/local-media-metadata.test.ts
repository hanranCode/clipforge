// @vitest-environment node
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { mkdtemp,mkdir,writeFile,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const state=vi.hoisted(()=>({root:"",probe:vi.fn()}));
vi.mock("@/lib/paths",()=>({getDataDir:()=>state.root,getOutputDir:()=>join(state.root,"output")}));
vi.mock("@/lib/media-probe",()=>({probeMedia:state.probe}));
import { localVideoMetadata } from "@/lib/local-media-metadata";
import { materialResolution } from "@/lib/asset-library";
beforeEach(async()=>{state.root=await mkdtemp(join(tmpdir(),"media-metadata-"));await mkdir(join(state.root,"uploads"));await writeFile(join(state.root,"uploads/video.mp4"),"video");state.probe.mockReset().mockResolvedValue({width:496,height:864,duration:9});});
afterEach(async()=>{await rm(state.root,{recursive:true,force:true});});
it("persists measured resolution and invalidates metadata when a local file changes",async()=>{
 expect(await localVideoMetadata("/api/files/video.mp4")).toEqual({width:496,height:864,durationSec:9});await localVideoMetadata("/api/files/video.mp4");expect(state.probe).toHaveBeenCalledTimes(1);
 await writeFile(join(state.root,"uploads/video.mp4"),"new longer video");state.probe.mockResolvedValue({width:1080,height:1920,duration:9});expect(await localVideoMetadata("/api/files/video.mp4")).toMatchObject({width:1080,height:1920});expect(state.probe).toHaveBeenCalledTimes(2);
});
it("does not download cloud resources merely to render library cards",async()=>{expect(await localVideoMetadata("https://storage.example.com/a.mp4")).toEqual({});expect(await localVideoMetadata("/api/agent-studio/resources/task-1")).toEqual({});expect(state.probe).not.toHaveBeenCalled();});
it("uses exact geometry and leaves missing dimensions unknown",()=>{expect(materialResolution({width:496,height:864})).toBe("496 × 864");expect(materialResolution({width:1080,height:1920})).toBe("1080 × 1920");expect(materialResolution({width:0,height:0})).toBeNull();});
