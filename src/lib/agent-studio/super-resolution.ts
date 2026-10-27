import { realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { getOutputDir } from "@/lib/paths";
import { runVideoUpscale, upscalePending, type UpscaleAction } from "@/lib/video-upscale";
import { studioStore } from "./store";
import { superResolutionTasks } from "./types";
import { recordAgentProgress, syncAgentWork } from "./catalog";
import { agentResourceUrl } from "./resources";

export { aiNodesConfigured } from "./ai-nodes-client";

/** Adapt completed Agent versions to the shared, durable upscale lifecycle. */
export async function superResolve(workId: string, versionId: string, action: UpscaleAction, options?: unknown, requestId?: string) {
  const version = () => {
    const v = studioStore().work(workId).versions.find(v => v.id === versionId);
    if (!v || v.status !== "completed" || !v.outputUrl) throw new Error("请选择已完成的视频版本 / Select a completed video version");
    return v;
  };
  version();
  await runVideoUpscale({
    key: `agent/${workId}/${versionId}`, logPrefix: "agent-upscale",
    tasks: () => superResolutionTasks(version()),
    inputFile: async () => {
      const root = await realpath(join(getOutputDir(), "agent-studio"));
      const dir = await realpath(join(root, workId, "versions", versionId));
      if (!dir.startsWith(root + sep)) throw new Error("视频目录无效 / Invalid video directory");
      const file = await realpath(join(dir, "final.mp4"));
      if (!file.startsWith(dir + sep)) throw new Error("视频文件无效 / Invalid video file");
      return file;
    },
    append: task => {
      studioStore().update(workId, w => {
        const v = w.versions.find(v => v.id === versionId)!;
        const tasks = superResolutionTasks(v);
        if (tasks.some(upscalePending) || action === "start" && tasks.some(t => t.status === "completed")) throw new Error("此版本已有超分任务，请查询原任务 / An upscale already exists; query its status");
        v.superResolutions = [...tasks, task]; v.superResolution = task;
      });
      recordAgentProgress(studioStore().work(workId));
    },
    update: (id, change) => {
      studioStore().update(workId, w => {
        const v = w.versions.find(v => v.id === versionId)!;
        for (const task of [v.superResolution, ...(v.superResolutions || [])]) if (task?.requestId === id) change(task);
      });
      recordAgentProgress(studioStore().work(workId));
    },
    resourceUrl: agentResourceUrl,
    onSubmitted: () => { studioStore().event(workId, "system", "已提交1080P超分，原成片已保留 / 1080P upscale submitted; original retained"); },
    onCompleted: async () => { await syncAgentWork(studioStore().work(workId)); },
  }, action, options, requestId);
}
