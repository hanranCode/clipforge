"use client";
import { useEffect, useState } from "react";
import { LuLoaderCircle, LuSend } from "react-icons/lu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { PlatformExportPanel, type ExportComposition } from "@/components/platform-export-panel";
import type { PublishVideoFamily } from "@/lib/publish-video";
import { useT } from "@/lib/i18n";

function PublishVideos({ projectId, sourceId }: { projectId: string; sourceId: string }) {
  const t = useT("exportPage");
  const [data, setData] = useState<PublishVideoFamily | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/project/${projectId}/publish-videos?sourceId=${encodeURIComponent(sourceId)}`, { signal: controller.signal })
      .then(async response => {
        const result = await response.json();
        if (!response.ok || !Array.isArray(result.videos) || !result.videos.some((v: ExportComposition) => v.id === result.preferredId)) throw new Error(result.error || t("publishVideosFailed"));
        if (!controller.signal.aborted) setData(result);
      }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : t("publishVideosFailed")); });
    return () => controller.abort();
  }, [projectId, sourceId, attempt, t]);
  if (error) return <div role="alert" className="space-y-3"><p className="text-sm text-destructive">{error}</p><Button variant="outline" onClick={() => { setError(""); setAttempt(n => n + 1); }}>{t("retryExport")}</Button></div>;
  return data ? <PlatformExportPanel projectId={projectId} compositions={data.videos} initialCompositionId={data.preferredId} /> : <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><LuLoaderCircle className="size-4 animate-spin" />{t("publishVideosLoading")}</p>;
}

/** All entrances resolve the selected take's originals/upscales when opening, so stale cards cannot pin an old default. */
export function PublishVideoButton({ projectId, video }: { projectId: string; video: ExportComposition }) {
  const [open, setOpen] = useState(false);
  const t = useT("projectsPage");
  return <>
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}><LuSend />{t("publish")}</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="w-[95vw] sm:max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogTitle>{t("publish")}</DialogTitle>
        {open && <PublishVideos key={`${projectId}:${video.id}`} projectId={projectId} sourceId={video.id} />}
      </DialogContent>
    </Dialog>
  </>;
}
