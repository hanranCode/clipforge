"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LuCheck,
  LuCircleAlert,
  LuDownload,
  LuFolderOpen,
  LuLoaderCircle,
  LuPlay,
  LuRefreshCw,
  LuSave,
  LuSparkles,
  LuUpload,
  LuX,
} from "react-icons/lu";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { LibraryVideoPicker } from "@/components/library-video-picker";
import { SegmentedVideo } from "@/components/segmented-video";
import type { LibrarySegment } from "@/lib/asset-library";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useCharacterStore } from "@/lib/stores/project-store";
import { buildVideoOptions, mergeCustomModels } from "@/lib/gen-params";
import { findModelFor, modelForUsage, providerForUsage } from "@/lib/model-usage";
import { modelScenarios, type ScenarioModel } from "@/lib/model-scenarios";
import { isObjectStorageConfigured } from "@/lib/object-storage";
import { isPaidTTSReady, resolveTTSConfig } from "@/lib/tts-presets";
import { mapWithConcurrency } from "@/lib/concurrency";
import {
  REMAKE_MAX_SEGMENT_SEC,
  buildSegmentRequest,
  cuesFromTranscript,
  isOpComplete,
  planSegments,
  type DubCue,
  type RemakeAudioMode,
  type RemakeImage,
  type RemakeOp,
  type RemakeSegment,
  type TimeSpan,
} from "@/lib/remake/plan";
import { VideoTimeline, formatClock, type TimelineMark } from "./_components/video-timeline";
import { OpsEditor } from "./_components/ops-editor";
import { AudioPanel } from "./_components/audio-panel";
import { useTranscribe } from "./_components/use-transcribe";

interface SourceInfo {
  jobId: string;
  path: string;
  label: string;
  duration: number;
  width: number;
  height: number;
  frameRate: number;
  hasAudio: boolean;
  sceneTimes: number[];
}

interface ModelTarget {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  canEdit: boolean;
}

type SegStatus = "idle" | "preparing" | "running" | "saving" | "done" | "skipped" | "failed" | "cancelled";
interface SegRun {
  status: SegStatus;
  /** local clip that represents this segment in the final cut (edited result or original cut) */
  path?: string;
  error?: string;
}

/** Everything the page needs to pick up where it left off (projects.remake_draft) */
interface RemakeDraft {
  version: 1;
  source: SourceInfo | null;
  images: RemakeImage[];
  ops: RemakeOp[];
  extra: string;
  keepSubtitles: boolean;
  audioMode: RemakeAudioMode;
  presenterId: string | null;
  voiceId: string;
  cues: DubCue[];
  dub: DubResult | null;
  runs: Record<number, SegRun>;
  final: FinalResult | null;
}

/** The finished remake as filed in the asset library; `segments` when it was edited in parts */
interface FinalResult {
  id: string;
  url: string;
  segments?: LibrarySegment[] | null;
}

interface DubResult {
  key: string;
  dubPath: string;
  segmentAudio: Record<number, string>;
}

/** Edit calls in flight at once: enough to overlap queueing, gentle on rate limits */
const EDIT_CONCURRENCY = 2;
const EDGE_VOICE = /^[a-zA-Z]{2,3}-[a-zA-Z0-9-]+Neural$/;

function StepHeader({ n, title, desc, active }: { n: number; title: string; desc?: string; active: boolean }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
          active ? "brand-gradient text-white" : "bg-muted text-muted-foreground"
        }`}
      >
        {n}
      </div>
      <div className="min-w-0">
        <h2 className={`text-lg font-semibold ${active ? "" : "text-muted-foreground"}`}>{title}</h2>
        {desc && <p className="text-xs text-muted-foreground">{desc}</p>}
      </div>
    </div>
  );
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data as { error?: string }).error || `HTTP ${res.status}`) as Error & { recoverable?: boolean };
    err.recoverable = Boolean((data as { recoverable?: boolean }).recoverable);
    throw err;
  }
  return data as T;
}

export default function RemakePage() {
  const t = useT("remake");
  const settings = useSettingsStore();
  const { providers, customModels, videoParams, objectStorage, tts } = settings;
  const remakeModel = useSettingsStore((s) => modelForUsage(s, "videoRemake"));
  const remakeProvider = useSettingsStore((s) => providerForUsage(s, "videoRemake"));
  const presenters = useCharacterStore((s) => s.characters);

  // ---------- model ----------
  const [target, setTarget] = useState<ModelTarget | null>(null);
  useEffect(() => {
    let cancelled = false;
    const enabled = Object.entries(providers)
      .filter(([, p]) => p.enabled && p.apiKey)
      .map(([name, p]) => ({ name, apiKey: p.apiKey, baseUrl: p.baseUrl }));
    if (!enabled.length || !remakeModel) {
      queueMicrotask(() => !cancelled && setTarget(null));
      return () => {
        cancelled = true;
      };
    }
    (async () => {
      try {
        const res = await fetch("/api/ai/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providers: enabled, mediaType: "video" }),
        });
        if (!res.ok) return;
        const data = await res.json();
        const merged = mergeCustomModels(data.models ?? [], customModels, "video", new Set(enabled.map((e) => e.name)));
        const model = findModelFor(merged, remakeModel, remakeProvider);
        const prov = model && enabled.find((e) => e.name === model.provider);
        if (cancelled || !model || !prov) return;
        const canEdit = modelScenarios(model as unknown as ScenarioModel).includes("videoEdit");
        setTarget({ provider: prov.name, model: model.id, apiKey: prov.apiKey, baseUrl: prov.baseUrl, canEdit });
      } catch {
        /* stays unconfigured */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [providers, customModels, remakeModel, remakeProvider]);
  const needsStorage = target?.provider === "volcengine" && !isObjectStorageConfigured(objectStorage);

  // ---------- source ----------
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [selection, setSelection] = useState<TimeSpan | null>(null);

  const segments = useMemo<RemakeSegment[]>(() => {
    if (!source) return [];
    try {
      return planSegments(source.duration, { sceneTimes: source.sceneTimes });
    } catch {
      return [];
    }
  }, [source]);

  // ---------- edits ----------
  const [images, setImages] = useState<RemakeImage[]>([]);
  const [ops, setOps] = useState<RemakeOp[]>([]);
  const [extra, setExtra] = useState("");
  const [keepSubtitles, setKeepSubtitles] = useState(true);
  const [audioMode, setAudioMode] = useState<RemakeAudioMode>("keep");

  // ---------- dub ----------
  const [presenterId, setPresenterId] = useState<string | null>(null);
  const [voiceId, setVoiceId] = useState("");
  const [cues, setCues] = useState<DubCue[]>([]);
  const [dub, setDub] = useState<DubResult | null>(null);
  const [dubbing, setDubbing] = useState(false);
  const [dubError, setDubError] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const { state: transcribeState, transcribe, cancel: cancelTranscribe } = useTranscribe();
  const paidReady = isPaidTTSReady(tts, providers);
  const paidConfig = paidReady ? resolveTTSConfig(tts, providers) : null;

  const dubVoice = useMemo(() => {
    if (!voiceId) return null;
    if (EDGE_VOICE.test(voiceId)) return { kind: "free" as const, voice: voiceId };
    if (paidConfig) return { kind: "paid" as const, config: { ...paidConfig, voice: voiceId } };
    return null;
  }, [voiceId, paidConfig]);
  const dubKey = useMemo(
    () => JSON.stringify({ cues: cues.map((c) => [c.start, c.end, c.text]), voice: [dubVoice?.kind, voiceId], segments: segments.map((s) => [s.start, s.end]) }),
    [cues, dubVoice, voiceId, segments],
  );
  const dubReady = Boolean(dub && dub.key === dubKey);

  const choosePresenter = (id: string) => {
    setPresenterId(id);
    const p = presenters.find((c) => c.id === id);
    if (p?.voiceProfile?.voice) setVoiceId(p.voiceProfile.voice);
  };
  const usePresenterImage = () => {
    const p = presenters.find((c) => c.id === presenterId);
    const url = p?.referenceImages?.[0];
    if (!p || !url || images.some((img) => img.url === url) || images.length >= 9) return;
    const image = { id: crypto.randomUUID(), url, label: p.name };
    setImages([...images, image]);
    // a presenter image is almost always meant to replace the on-screen person
    if (!ops.some((op) => op.kind === "person")) {
      setOps([...ops, { id: crypto.randomUUID(), kind: "person", target: "", detail: "", imageId: image.id }]);
    }
  };

  // ---------- generation ----------
  const requests = useMemo(
    () => segments.map((segment) => buildSegmentRequest({ segment, ops, images, keepSubtitles, audioMode, cues, extraInstruction: extra })),
    [segments, ops, images, keepSubtitles, audioMode, cues, extra],
  );
  const editCount = requests.filter((r) => r.needsEdit).length;
  const editSeconds = requests.filter((r) => r.needsEdit).reduce((sum, r) => sum + (r.segment.end - r.segment.start), 0);

  const [runs, setRuns] = useState<Record<number, SegRun>>({});
  const [running, setRunning] = useState(false);
  const [assembling, setAssembling] = useState(false);
  const [runError, setRunError] = useState("");
  const [final, setFinal] = useState<FinalResult | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLVideoElement>(null);
  const compareRef = useRef<HTMLVideoElement>(null);

  // ---------- draft (saved as a project, listed under 我的项目) ----------
  const [draftId, setDraftId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [savingDraft, setSavingDraft] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [draftError, setDraftError] = useState("");
  const [restoring, setRestoring] = useState(false);
  const [autoSave, setAutoSave] = useState<null | "draft" | "done">(null);

  const defaultName = source ? t("titleDefault", { name: source.label }) : t("pageTitle");
  const saveDraft = async (status: "draft" | "done" = final ? "done" : "draft") => {
    setSavingDraft(true);
    setDraftError("");
    try {
      const draft: RemakeDraft = {
        version: 1,
        source,
        images,
        ops,
        extra,
        keepSubtitles,
        audioMode,
        presenterId,
        voiceId,
        cues,
        dub,
        // only finished segments are worth keeping; in-flight states mean nothing after a reload
        runs: Object.fromEntries(Object.entries(runs).filter(([, r]) => r.path && (r.status === "done" || r.status === "skipped"))),
        final,
      };
      const data = await postJson<{ id: string }>("/api/remake/draft", { id: draftId ?? undefined, name: draftName.trim() || defaultName, status, draft });
      setDraftId(data.id);
      setSavedAt(new Date());
      const url = new URL(window.location.href);
      url.searchParams.set("id", data.id);
      window.history.replaceState(null, "", url);
    } catch (error) {
      setDraftError(`${t("draftSaveFailed")}：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSavingDraft(false);
    }
  };
  const saveDraftRef = useRef(saveDraft);
  saveDraftRef.current = saveDraft;

  // a finished (or partly finished) run is saved right away: paid results must not live only in this tab
  useEffect(() => {
    if (!autoSave || running) return;
    const status = autoSave;
    queueMicrotask(() => {
      setAutoSave(null);
      void saveDraftRef.current(status);
    });
  }, [autoSave, running]);

  // reopen a draft from 我的项目 (/project/remake?id=…)
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("id");
    if (!id) return;
    let cancelled = false;
    queueMicrotask(() => setRestoring(true));
    fetch(`/api/remake/draft?id=${encodeURIComponent(id)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || String(res.status));
        return data as { id: string; name: string; draft: Partial<RemakeDraft> | null };
      })
      .then(({ id: projectId, name, draft }) => {
        if (cancelled) return;
        setDraftId(projectId);
        setDraftName(name);
        if (!draft) return;
        setSource(draft.source ?? null);
        setImages(Array.isArray(draft.images) ? draft.images : []);
        setOps(Array.isArray(draft.ops) ? draft.ops : []);
        setExtra(typeof draft.extra === "string" ? draft.extra : "");
        setKeepSubtitles(draft.keepSubtitles !== false);
        setAudioMode(draft.audioMode === "mute" || draft.audioMode === "dub" ? draft.audioMode : "keep");
        setPresenterId(draft.presenterId ?? null);
        setVoiceId(typeof draft.voiceId === "string" ? draft.voiceId : "");
        setCues(Array.isArray(draft.cues) ? draft.cues : []);
        setDub(draft.dub ?? null);
        setRuns(draft.runs && typeof draft.runs === "object" ? draft.runs : {});
        setFinal(draft.final ?? null);
      })
      .catch((error) => !cancelled && setDraftError(`${t("draftLoadFailed")}：${error instanceof Error ? error.message : String(error)}`))
      .finally(() => !cancelled && setRestoring(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per page visit; t is stable per locale
  }, []);

  const resetOutputs = () => {
    setRuns({});
    setFinal(null);
    setRunError("");
    setDub(null);
  };

  const loadSource = async (input: { path: string; label: string } | { file: File }) => {
    setLoadingSource(true);
    setSourceError("");
    try {
      let res: Response;
      if ("file" in input) {
        const form = new FormData();
        form.append("file", input.file);
        res = await fetch("/api/remake/source", { method: "POST", body: form });
      } else {
        res = await fetch("/api/remake/source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: input.path }) });
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "source");
      if (data.duration < 4) throw new Error(t("tooShort"));
      setSource({ ...data, label: "file" in input ? input.file.name.replace(/\.[^.]+$/, "") : input.label });
      setSelection(null);
      setCues([]);
      resetOutputs();
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingSource(false);
    }
  };

  const runTranscribe = async () => {
    if (!source) return;
    const segs = await transcribe(source.path, source.duration);
    if (segs) setCues(cuesFromTranscript(segs, source.duration));
  };

  const previewVoice = async () => {
    if (!dubVoice) return;
    setPreviewing(true);
    try {
      const res = await fetch("/api/remake/voice-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: cues.find((c) => c.text.trim())?.text || "大家好，今天给你们分享一个好东西。", voice: dubVoice }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "preview");
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch (error) {
      setDubError(error instanceof Error ? error.message : String(error));
    } finally {
      setPreviewing(false);
    }
  };

  const buildDub = useCallback(
    async (signal?: AbortSignal): Promise<DubResult> => {
      if (!source) throw new Error("source");
      if (!dubVoice) throw new Error(t("errorNoVoice"));
      if (!cues.some((c) => c.text.trim())) throw new Error(t("errorNoCues"));
      setDubbing(true);
      setDubError("");
      try {
        const data = await postJson<{ dubPath: string; segmentAudio: Record<number, string> }>(
          "/api/remake/dub",
          { jobId: source.jobId, duration: source.duration, cues, voice: dubVoice, segments },
          signal,
        );
        const result = { key: dubKey, ...data };
        setDub(result);
        return result;
      } catch (error) {
        setDubError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        setDubbing(false);
      }
    },
    [source, dubVoice, cues, segments, dubKey, t],
  );

  const setRun = (index: number, patch: SegRun) => setRuns((prev) => ({ ...prev, [index]: { ...prev[index], ...patch } }));

  const generate = async (onlyFailed = false) => {
    if (!source || running) return;
    setRunError("");
    if (!target) return setRunError(t("errorNoModel"));
    if (!target.canEdit) return setRunError(t("modelNotEdit"));
    if (needsStorage) return setRunError(t("modelNeedStorage"));
    if (!editCount) return setRunError(t("errorNoOps"));
    if (audioMode === "dub" && !dubVoice) return setRunError(t("errorNoVoice"));
    if (audioMode === "dub" && !cues.some((c) => c.text.trim())) return setRunError(t("errorNoCues"));

    let finished = false;
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    setRunning(true);
    setFinal(null);
    const previous = runs;
    const done = new Map<number, string>();
    for (const r of requests) {
      const prev = previous[r.segment.index];
      if (onlyFailed && prev?.path && (prev.status === "done" || prev.status === "skipped")) done.set(r.segment.index, prev.path);
      else setRun(r.segment.index, { status: "preparing", error: undefined });
    }
    try {
      const cut = await postJson<{ segments: Array<{ index: number; path: string }> }>(
        "/api/remake/segments",
        { jobId: source.jobId, path: source.path, segments },
        signal,
      );
      const cutPath = new Map(cut.segments.map((s) => [s.index, s.path]));
      const dubResult = audioMode === "dub" ? (dubReady && dub ? dub : await buildDub(signal)) : null;
      const isArk = target.provider === "volcengine";

      await mapWithConcurrency(
        requests.filter((r) => !done.has(r.segment.index)),
        EDIT_CONCURRENCY,
        async (req) => {
          const { index, start, end } = req.segment;
          const original = cutPath.get(index)!;
          if (!req.needsEdit) {
            done.set(index, original);
            setRun(index, { status: "skipped", path: original });
            return;
          }
          if (signal.aborted) return setRun(index, { status: "cancelled" });
          setRun(index, { status: "running" });
          try {
            const audioRef = req.useDubAudio ? dubResult?.segmentAudio[index] : undefined;
            const gen = await postJson<{ videoUrls?: string[] }>(
              "/api/ai/video",
              {
                provider: target.provider,
                model: target.model,
                apiKey: target.apiKey,
                baseUrl: target.baseUrl,
                mode: "video-to-video",
                prompt: req.prompt,
                referenceVideoUrls: [original],
                referenceImageUrls: req.imageUrls,
                ...(audioRef && { referenceAudioUrls: [audioRef] }),
                objectStorage: isObjectStorageConfigured(objectStorage) ? objectStorage : undefined,
                scene: "video_remake",
                options: {
                  ...buildVideoOptions(videoParams),
                  width: source.width,
                  height: source.height,
                  duration: Math.max(4, Math.round(end - start)),
                  audioEnabled: Boolean(audioRef),
                  // Ark edit mode: output keeps the source clip's length and aspect ratio
                  ...(isArk && { extra: { omni_reference_task_type: "edit", ratio: "adaptive", duration: -1 } }),
                },
              },
              signal,
            );
            const url = gen.videoUrls?.[0];
            if (!url) throw new Error("no video");
            setRun(index, { status: "saving" });
            const saved = await postJson<{ path: string }>("/api/remake/result", { jobId: source.jobId, index, url }, signal);
            done.set(index, saved.path);
            setRun(index, { status: "done", path: saved.path });
          } catch (error) {
            if (signal.aborted) return setRun(index, { status: "cancelled" });
            setRun(index, { status: "failed", error: error instanceof Error ? error.message : String(error) });
          }
        },
      );

      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      if (done.size !== segments.length) return; // some segment failed — retry offered per segment

      setAssembling(true);
      const editedIndexes = new Set(requests.filter((r) => r.needsEdit).map((r) => r.segment.index));
      const result = await postJson<FinalResult>(
        "/api/remake/finalize",
        {
          jobId: source.jobId,
          sourcePath: source.path,
          segments: segments.map((s) => ({ start: s.start, end: s.end, path: done.get(s.index), edited: editedIndexes.has(s.index) })),
          audioMode,
          dubPath: dubResult?.dubPath,
          title: t("titleDefault", { name: source.label }),
          description: requests.filter((r) => r.needsEdit).map((r) => r.prompt.split("\n")[0]).join("\n"),
        },
        signal,
      );
      setFinal(result);
      finished = true;
    } catch (error) {
      if (signal.aborted || (error as Error).name === "AbortError") {
        setRunError(t("errorCancelled"));
        setRuns((prev) =>
          Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, ["preparing", "running", "saving"].includes(v.status) ? { ...v, status: "cancelled" as const } : v])),
        );
      } else {
        setRunError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setAssembling(false);
      setRunning(false);
      abortRef.current = null;
      setAutoSave(finished ? "done" : "draft");
    }
  };

  const marks: TimelineMark[] = ops.flatMap((op, i) => (op.range ? [{ id: op.id, start: op.range.start, end: op.range.end, label: `${i + 1}. ${t(`opKind_${op.kind}`)}` }] : []));
  const failedCount = Object.values(runs).filter((r) => r.status === "failed" || r.status === "cancelled").length;
  const hasEdits = ops.some(isOpComplete) || audioMode === "dub";

  const seek = (time: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = time;
    setCurrentTime(time);
  };

  const syncPlay = () => {
    const a = compareRef.current;
    const b = resultRef.current;
    if (!a || !b) return;
    a.currentTime = 0;
    b.currentTime = 0;
    a.muted = true;
    void a.play();
    void b.play();
  };

  return (
    <div className="min-h-screen grid-bg">
      <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <div className="mb-8">
          <h1 className="mb-2 text-3xl font-bold tracking-tight">
            <span className="brand-gradient-text">{t("pageTitle")}</span>
          </h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{t("pageSubtitle")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t("modelLabel")}:</span>
            <span className={`rounded-full px-2 py-0.5 font-mono ${target?.canEdit ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
              {target ? `${target.model} · ${target.provider}` : t("modelNone")}
            </span>
            <Link href="/settings?tab=video" className="text-primary hover:underline">
              {t("modelConfigure")}
            </Link>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder={defaultName}
              aria-label={t("draftName")}
              className="h-9 w-full text-sm sm:w-72"
            />
            <Button variant="outline" size="sm" disabled={savingDraft || restoring || running} onClick={() => void saveDraft()}>
              {savingDraft ? <LuLoaderCircle className="animate-spin" /> : <LuSave />}
              {savingDraft ? t("savingDraft") : t("saveDraft")}
            </Button>
            {restoring && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <LuLoaderCircle className="size-3.5 animate-spin" />
                {t("restoringDraft")}
              </span>
            )}
            {savedAt && (
              <span className="flex items-center gap-1 text-xs text-emerald-600">
                <LuCheck className="size-3.5" />
                {t("draftSavedAt", { time: savedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}
                <Link href="/projects" className="ml-1 text-primary hover:underline">
                  {t("openProjects")}
                </Link>
              </span>
            )}
          </div>
          {draftError && <p className="mt-2 text-xs text-destructive">{draftError}</p>}
          {target && !target.canEdit && <p className="mt-2 text-xs text-amber-600">{t("modelNotEdit")}</p>}
          {needsStorage && (
            <p className="mt-2 text-xs text-amber-600">
              {t("modelNeedStorage")} ·{" "}
              <Link href="/settings?tab=storage" className="underline">
                {t("modelConfigure")}
              </Link>
            </p>
          )}
        </div>

        {/* Step 1 — source */}
        <section className="mb-10">
          <StepHeader n={1} title={t("step1Title")} desc={t("step1Desc")} active />
          <Card className="glass-card">
            <CardContent className="space-y-4 p-4 sm:p-6">
              <input
                ref={fileRef}
                type="file"
                accept="video/mp4,video/webm,video/quicktime"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void loadSource({ file: f });
                }}
              />
              <LibraryVideoPicker open={pickerOpen} onOpenChange={setPickerOpen} onPick={(v) => void loadSource({ path: v.url, label: v.label })} />
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={() => setPickerOpen(true)} disabled={loadingSource || running}>
                  <LuFolderOpen />
                  {source ? t("replaceSource") : t("pickLibrary")}
                </Button>
                <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={loadingSource || running}>
                  <LuUpload />
                  {t("upload")}
                </Button>
                {loadingSource && (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <LuLoaderCircle className="size-3.5 animate-spin" />
                    {t("loadingSource")}
                  </span>
                )}
                {source && (
                  <span className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{source.label}</span> ·{" "}
                    {t("sourceMeta", { duration: formatClock(source.duration, true), width: source.width, height: source.height, fps: Math.round(source.frameRate) })}
                    {!source.hasAudio && ` · ${t("sourceNoAudio")}`}
                  </span>
                )}
              </div>
              {sourceError && <p className="text-xs text-destructive">{sourceError}</p>}

              {source && (
                <>
                  <div className="overflow-hidden rounded-xl bg-black">
                    <video
                      ref={videoRef}
                      src={source.path}
                      controls
                      playsInline
                      className="mx-auto max-h-[42vh] w-auto max-w-full"
                      onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                      onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
                    />
                  </div>
                  <VideoTimeline
                    src={source.path}
                    duration={source.duration}
                    currentTime={currentTime}
                    segments={segments}
                    marks={marks}
                    selection={selection}
                    onSeek={seek}
                    onSelect={setSelection}
                  />
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{t("timelineHint")}</span>
                    {selection && (
                      <span className="flex items-center gap-1 text-primary">
                        {t("selection", { start: selection.start.toFixed(1), end: selection.end.toFixed(1) })}
                        <button type="button" aria-label={t("clearSelection")} onClick={() => setSelection(null)}>
                          <LuX className="size-3.5" />
                        </button>
                      </span>
                    )}
                  </div>
                  <div className="rounded-lg border border-border/60 bg-muted/10 p-3 text-xs">
                    <p className="font-medium">{t("segmentsTitle")}</p>
                    <p className="mt-0.5 text-muted-foreground">
                      {segments.length > 1 ? t("segmentsDesc", { max: REMAKE_MAX_SEGMENT_SEC, count: segments.length }) : t("segmentsSingle")}
                    </p>
                    {segments.length > 1 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {segments.map((s) => (
                          <button
                            key={s.index}
                            type="button"
                            onClick={() => seek(s.start)}
                            className="rounded-md border border-border/60 bg-background px-2 py-1 tabular-nums hover:border-primary/60"
                          >
                            {t("segmentLabel", { n: s.index + 1 })} · {formatClock(s.start, true)}–{formatClock(s.end, true)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Step 2 — instructions */}
        <section className={`mb-10 ${source ? "" : "pointer-events-none opacity-50"}`}>
          <StepHeader n={2} title={t("step2Title")} desc={t("step2Desc")} active={Boolean(source)} />
          <Card className="glass-card">
            <CardContent className="space-y-5 p-4 sm:p-6">
              <OpsEditor images={images} onImagesChange={setImages} ops={ops} onOpsChange={setOps} selection={selection} />
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">{t("extraTitle")}</p>
                <Textarea value={extra} onChange={(e) => setExtra(e.target.value)} placeholder={t("extraPlaceholder")} rows={2} className="resize-none text-sm" />
              </div>
              {source && hasEdits && (
                <details className="rounded-lg border border-border/60 bg-muted/10 p-3 text-xs">
                  <summary className="cursor-pointer font-medium">{t("promptPreview")}</summary>
                  <div className="mt-3 space-y-3">
                    {requests.map((r) => (
                      <div key={r.segment.index} className="space-y-1">
                        <p className="font-medium text-muted-foreground">
                          {t("promptSegment", { n: r.segment.index + 1, start: r.segment.start.toFixed(1), end: r.segment.end.toFixed(1) })}
                        </p>
                        {r.needsEdit ? (
                          <pre className="whitespace-pre-wrap rounded-md bg-background/60 p-2 font-sans leading-5">{r.prompt}</pre>
                        ) : (
                          <p className="text-muted-foreground">{t("promptSkip")}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Step 3 — subtitles & audio */}
        <section className={`mb-10 ${source ? "" : "pointer-events-none opacity-50"}`}>
          <StepHeader n={3} title={t("step3Title")} active={Boolean(source)} />
          <Card className="glass-card">
            <CardContent className="p-4 sm:p-6">
              <AudioPanel
                keepSubtitles={keepSubtitles}
                onKeepSubtitlesChange={setKeepSubtitles}
                audioMode={audioMode}
                onAudioModeChange={setAudioMode}
                presenters={presenters}
                presenterId={presenterId}
                onPresenterChange={choosePresenter}
                onUsePresenterImage={usePresenterImage}
                voiceId={voiceId}
                onVoiceChange={setVoiceId}
                paidVoice={paidConfig?.voice ?? null}
                onPreviewVoice={() => void previewVoice()}
                previewing={previewing}
                cues={cues}
                onCuesChange={setCues}
                hasAudio={Boolean(source?.hasAudio)}
                currentTime={currentTime}
                transcribeState={transcribeState}
                onTranscribe={() => void runTranscribe()}
                dubbing={dubbing}
                dubReady={dubReady}
                dubPath={dub?.dubPath ?? null}
                onBuildDub={() => void buildDub().catch(() => {})}
              />
              {dubError && <p className="mt-3 text-xs text-destructive">{dubError}</p>}
            </CardContent>
          </Card>
        </section>

        {/* Step 4 — generate */}
        <section className={`mb-10 ${source ? "" : "pointer-events-none opacity-50"}`}>
          <StepHeader
            n={4}
            title={t("step4Title")}
            desc={source ? t("step4Desc", { edit: editCount, skip: segments.length - editCount }) : undefined}
            active={Boolean(source && hasEdits)}
          />
          <Card className="glass-card">
            <CardContent className="space-y-4 p-4 sm:p-6">
              <div className="flex flex-wrap items-center gap-3">
                <Button className="brand-gradient text-white" disabled={!source || running || loadingSource} onClick={() => void generate(false)}>
                  {running ? <LuLoaderCircle className="animate-spin" /> : <LuSparkles />}
                  {running ? (assembling ? t("assembling") : t("generating")) : t("generate")}
                </Button>
                {running && (
                  <Button variant="outline" onClick={() => abortRef.current?.abort()}>
                    {t("cancel")}
                  </Button>
                )}
                {!running && failedCount > 0 && (
                  <Button variant="outline" onClick={() => void generate(true)}>
                    <LuRefreshCw />
                    {t("retryFailed")}
                  </Button>
                )}
                {source && editSeconds > 0 && <span className="text-xs text-muted-foreground">{t("estimate", { seconds: Math.round(editSeconds) })}</span>}
              </div>
              {runError && (
                <p className="flex items-start gap-1.5 text-xs text-destructive">
                  <LuCircleAlert className="mt-0.5 size-3.5 shrink-0" />
                  {runError}
                </p>
              )}
              {Object.keys(runs).length > 0 && (
                <div className="divide-y divide-border/40 rounded-lg border border-border/60">
                  {segments.map((s) => {
                    const run = runs[s.index] ?? { status: "idle" as const };
                    const busy = run.status === "preparing" || run.status === "running" || run.status === "saving";
                    return (
                      <div key={s.index} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                        <span className="w-28 shrink-0 font-medium tabular-nums">
                          {t("segmentLabel", { n: s.index + 1 })} · {s.start.toFixed(1)}–{s.end.toFixed(1)}s
                        </span>
                        <span
                          className={`flex items-center gap-1 ${
                            run.status === "done" ? "text-emerald-600" : run.status === "failed" ? "text-destructive" : "text-muted-foreground"
                          }`}
                        >
                          {busy && <LuLoaderCircle className="size-3.5 animate-spin" />}
                          {run.status === "done" && <LuCheck className="size-3.5" />}
                          {t(`seg_${run.status}`)}
                        </span>
                        {run.error && <span className="min-w-0 flex-1 break-words text-destructive">{run.error}</span>}
                        {run.path && run.status === "done" && (
                          <a href={run.path} target="_blank" rel="noreferrer" className="ml-auto text-primary hover:underline">
                            <LuPlay className="inline size-3.5" />
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Step 5 — result */}
        {final && source && (
          <section className="mb-10">
            <StepHeader n={5} title={t("step5Title")} active />
            <Card className="glass-card">
              <CardContent className="space-y-4 p-4 sm:p-6">
                <div className="grid gap-3 sm:grid-cols-2">
                  <figure className="space-y-1">
                    <figcaption className="text-xs text-muted-foreground">{t("compareSource")}</figcaption>
                    <video ref={compareRef} src={source.path} controls playsInline muted className="w-full rounded-lg bg-black" />
                  </figure>
                  <figure className="space-y-1">
                    <figcaption className="text-xs text-muted-foreground">{t("compareResult")}</figcaption>
                    <div className="overflow-hidden rounded-lg border border-border/50">
                      <SegmentedVideo videoRef={resultRef} url={final.url} segments={final.segments} className="w-full bg-black" />
                    </div>
                  </figure>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={syncPlay}>
                    <LuPlay />
                    {t("syncPlay")}
                  </Button>
                  <a
                    href={final.url}
                    download
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm hover:bg-muted"
                  >
                    <LuDownload className="size-4" />
                    {t("download")}
                  </a>
                  <span className="flex items-center gap-1 text-xs text-emerald-600">
                    <LuCheck className="size-3.5" />
                    {t("savedToLibrary")}
                  </span>
                  <Link href={`/materials?open=${encodeURIComponent(final.id)}`} className="text-xs text-primary hover:underline">
                    {t("openLibrary")}
                  </Link>
                </div>
              </CardContent>
            </Card>
          </section>
        )}
      </main>
      {/* stop a running in-browser transcription when leaving */}
      <TranscribeCleanup cancel={cancelTranscribe} />
    </div>
  );
}

function TranscribeCleanup({ cancel }: { cancel: () => void }) {
  useEffect(() => cancel, [cancel]);
  return null;
}
