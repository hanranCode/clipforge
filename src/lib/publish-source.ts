import { realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { getOutputDir, getUploadsDir } from "@/lib/paths";

/** Only database-selected paths can reach this function; reject symlink escapes as well. */
export async function checkedPublishPath(path: string): Promise<string | null> {
  try {
    const file = await realpath(path);
    for (const root of [getOutputDir(), getUploadsDir()]) {
      const resolved = await realpath(root).catch(() => null);
      if (resolved && file.startsWith(resolved + sep)) return file;
    }
  } catch { /* deleted/unavailable source */ }
  return null;
}

export function completedVideoUrl(path: string, projectId: string): string {
  const rel = relative(getUploadsDir(), path);
  if (rel && !rel.startsWith("..") && !rel.startsWith(sep)) return `/api/files/${rel.split(sep).map(encodeURIComponent).join("/")}`;
  return `/api/output/${projectId}/${path.split(/[\\/]/).pop()}`;
}

export async function agentPublishSource(projectId: string, compositionId: string): Promise<string | null> {
  const { studioStore } = await import("@/lib/agent-studio/store");
  const { superResolutionTasks } = await import("@/lib/agent-studio/types");
  const work = studioStore().works().find(w => (w.projectId || w.id) === projectId);
  if (!work) return null;
  for (const v of work.versions) {
    if (v.status !== "completed" || !v.outputUrl) continue;
    if (compositionId === `agent-${v.id}` && [work.id, v.id].every(id => /^[a-zA-Z0-9-]+$/.test(id))) {
      return checkedPublishPath(join(getOutputDir(), "agent-studio", work.id, "versions", v.id, "final.mp4"));
    }
    const sr = superResolutionTasks(v).find(t => t.status === "completed" && `agent-upscale-${t.requestId}` === compositionId);
    if (sr) {
      const { agentResourceFile } = await import("@/lib/agent-studio/resources");
      // The resource resolver verifies the cached bytes and metadata; its cache is outside uploads/output.
      return (await agentResourceFile(sr.requestId)).file;
    }
  }
  return null;
}
