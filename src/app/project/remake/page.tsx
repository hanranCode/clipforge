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
import { LibraryVideoPicker } from "@/components/library-video-picker";
import { SegmentedVideo } from "@/components/segmented-video";
import type { LibrarySegment } from "@/lib/asset-library";
import { useT } from "@/lib/i18n";
import { useSettingsStore } from "@/lib/stores/settings-store";
import { useCharacterStore } from "@/lib/stores/project-store";
import { modelForUsage, providerForUsage } from "@/lib/model-usage";
import { remakeMaxImages, remakeProviderForModel } from "@/lib/remake/model";
import { isPaidTTSReady, resolveTTSConfig } from "@/lib/tts-presets";
import { defaultSegmentSettings, firstUnapprovedSegment, isSegmentApproved, segmentEditParams, type SegmentSettings } from "@/lib/remake/workflow";
import {
  buildSegmentRequest,
  canKeepRemakeSubtitles,
  cuesFromTranscript,
  cuesForSegment,
  planSegments,
  remakeSubtitleInstruction,
  type DubCue,
  type RemakeAudioMode,
  type RemakeImage,
  type RemakeOp,
  type RemakeSegment,
  type TimeSpan,
} from "@/lib/remake/plan";
import { VideoTimeline, formatClock, type TimelineMark } from "./_components/video-timeline";
import { SegmentParams } from "./_components/segment-params";
import { ReferenceImages } from "./_components/reference-images";
import type { ReferenceResource } from "@/lib/reference-resource";
import { isObjectStorageConfigured } from "@/lib/object-storage";
import { remapImageReferences, validPromptReferences } from "@/lib/remake/references";
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
}

type SegStatus = "idle" | "preparing" | "running" | "saving" | "done" | "skipped" | "failed" | "cancelled";
interface SegRun {
  status: SegStatus;
  /** local clip that represents this segment in the final cut (edited result or original cut) */
  path?: string;
  error?: string;
  key?: string;
  approved?: boolean;
  taskId?: string;
  taskModel?: string;
  taskProvider?: string;
  recoverable?: boolean;
  resultUrl?: string;
  draftId?: string;
  lastFrameUrl?: string;
}

/** Everything the page needs to pick up where it left off (projects.remake_draft) */
interface RemakeDraft {
  version: 2 | 3;
  maxSeconds: number;
  sceneCuts: boolean;
  segmentSettings: Record<number, SegmentSettings>;
  clips: Record<number, SegmentClip>;
  referenceTrack: ReferenceTrack | null;
  activeSegment: number;
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
  audioResources?: Record<number, ReferenceResource>;
}

interface SegmentClip { index: number; path: string; audioPath?: string; resource?: ReferenceResource; audioResource?: ReferenceResource }
interface ReferenceTrack { path: string; segmentAudio: Record<number, string>; resource?: ReferenceResource; audioResources?: Record<number, ReferenceResource> }
const EDGE_VOICE = /^[a-zA-Z]{2,3}-[a-zA-Z0-9-]+Neural$/;

/** Restore old saved-draft asset references to their original photos when available. */
function legacyReferenceSources(presenters: Array<{ name: string; referenceImages: string[]; arkPortrait?: { assets?: Array<{ id: string; sourceUrl?: string }> } }>) {
  const sources = new Map<string, string>();
  for (const presenter of presenters) {
    for (const asset of presenter.arkPortrait?.assets ?? []) {
      if (asset.sourceUrl) sources.set(`asset://${asset.id}`, asset.sourceUrl);
    }
  }
  return sources;
}

function restoreLegacyImages(images: RemakeImage[], presenters: Parameters<typeof legacyReferenceSources>[0]) {
  const sources = legacyReferenceSources(presenters);
  return images.map((image) => {
    const source = image.url.startsWith("asset://") ? sources.get(image.url) : undefined;
    return source ? { ...image, url: source, thumbUrl: image.thumbUrl ?? source } : image;
  });
}

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
    const err = new Error((data as { error?: string }).error || `HTTP ${res.status}`) as Error & { recoverable?: boolean; code?: string; taskId?: string };
    err.recoverable = Boolean((data as { recoverable?: boolean }).recoverable);
    err.code = (data as { code?: string }).code;
    err.taskId = (data as { taskId?: string }).taskId;
    throw err;
  }
  return data as T;
}

export default function RemakePage() {
  const t = useT("remake");
  const settings = useSettingsStore();
  const { providers, tts, objectStorage } = settings;
  const storageReady = isObjectStorageConfigured(objectStorage);
  const [uploadingImages, setUploadingImages] = useState(false);
  const remakeModel = useSettingsStore((s) => modelForUsage(s, "videoRemake"));
  const remakeProvider = useSettingsStore((s) => providerForUsage(s, "videoRemake"));
  const presenters = useCharacterStore((s) => s.characters);

  // ---------- source ----------
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [loadingSource, setLoadingSource] = useState(false);
  const [sourceError, setSourceError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [selection, setSelection] = useState<TimeSpan | null>(null);

  const [maxSeconds, setMaxSeconds] = useState(10);
  const [sceneCuts, setSceneCuts] = useState(true);
  const [segmentSettings, setSegmentSettings] = useState<Record<number, SegmentSettings>>({});
  const [clips, setClips] = useState<Record<number, SegmentClip>>({});
  const [preparing, setPreparing] = useState(false);
  const [activeSegment, setActiveSegment] = useState(0);
  const [referenceTrack, setReferenceTrack] = useState<ReferenceTrack | null>(null);
  const [uploadingAudio, setUploadingAudio] = useState(false);
  const audioFileRef = useRef<HTMLInputElement>(null);
  const segments = useMemo<RemakeSegment[]>(() => {
    if (!source) return [];
    try {
      return planSegments(source.duration, { maxSeconds, sceneTimes: sceneCuts ? source.sceneTimes : [] });
    } catch {
      return [];
    }
  }, [source, maxSeconds, sceneCuts]);

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
  const usePresenterImage = async () => {
    const presenter = presenters.find((character) => character.id === presenterId);
    const url = presenter?.referenceImages?.[0];
    if (!presenter || !url || images.length >= 30) return;
    setUploadingImages(true); setDubError("");
    try {
      const { resources } = await postJson<{ resources: ReferenceResource[] }>("/api/remake/resources", { objectStorage, references: [{ path: url, label: presenter.name }] });
      const resource = resources[0];
      if (images.some((image) => image.resource?.md5 === resource.md5)) return;
      setImages([...images, { id: resource.id, url: resource.path, label: presenter.name, resource }]);
      setAutoSave("draft"); setFinal(null);
    } catch (error) { setDubError((error as Error).message); }
    finally { setUploadingImages(false); }
  };

  // ---------- generation ----------
  const requests = useMemo(
    () => segments.map((segment) => {
      const request = buildSegmentRequest({ segment, ops, images, keepSubtitles, audioMode, cues, extraInstruction: extra });
      const urls = images.map((image) => image.url);
      const prompt = request.prompt.replace(/@Image(\d+)\b/g, (token, n: string) => {
        const i = urls.indexOf(request.imageUrls[Number(n) - 1]);
        return i >= 0 ? `@Image${i + 1}` : token;
      });
      return { ...request, needsEdit: request.needsEdit || images.length > 0, imageUrls: urls,
        prompt: prompt.startsWith("编辑视频") ? prompt : `编辑视频：按参考素材和以下要求修改 @Video1。\n${prompt}` };
    }),
    [segments, ops, images, keepSubtitles, audioMode, cues, extra],
  );

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
  const saveDraft = async (status: "draft" | "done" = final ? "done" : "draft", runOverride?: Record<number, SegRun>, projectOverride?: string) => {
    setSavingDraft(true);
    setDraftError("");
    try {
      const draft: RemakeDraft = {
        version: 3,
        maxSeconds, sceneCuts, segmentSettings, clips, referenceTrack, activeSegment,
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
        // Keep recovery handles and approval state alongside paid results.
        runs: runOverride ?? runs,
        final,
      };
      const data = await postJson<{ id: string }>("/api/remake/draft", { id: projectOverride ?? draftId ?? undefined, name: draftName.trim() || defaultName, status, draft });
      setDraftId(data.id);
      setSavedAt(new Date());
      const url = new URL(window.location.href);
      url.searchParams.set("id", data.id);
      window.history.replaceState(null, "", url);
      return data.id;
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
        setImages(restoreLegacyImages(Array.isArray(draft.images) ? draft.images : [], presenters));
        setOps(Array.isArray(draft.ops) ? draft.ops : []);
        setExtra(typeof draft.extra === "string" ? draft.extra : "");
        const restoredAudioMode = draft.audioMode === "mute" || draft.audioMode === "dub" || draft.audioMode === "generated" ? draft.audioMode : "keep";
        setKeepSubtitles(draft.keepSubtitles !== false && canKeepRemakeSubtitles(restoredAudioMode));
        setAudioMode(restoredAudioMode);
        setPresenterId(draft.presenterId ?? null);
        setVoiceId(typeof draft.voiceId === "string" ? draft.voiceId : "");
        setCues(Array.isArray(draft.cues) ? draft.cues : []);
        setDub(draft.dub ?? null);
        if (draft.version === 2 || draft.version === 3) {
          setMaxSeconds(draft.maxSeconds === 8 ? 8 : 10);
          setSceneCuts(draft.sceneCuts !== false);
          const restoredSettings = { ...draft.segmentSettings };
          if (draft.version === 2 && draft.source) {
            const oldSegments = planSegments(draft.source.duration, { maxSeconds: draft.maxSeconds === 8 ? 8 : 10, sceneTimes: draft.sceneCuts === false ? [] : draft.source.sceneTimes });
            for (const segment of oldSegments) {
              const old = restoredSettings[segment.index];
              if (!old?.prompt) continue;
              const request = buildSegmentRequest({ segment, ops: draft.ops ?? [], images: draft.images ?? [], keepSubtitles: draft.keepSubtitles !== false, audioMode: draft.audioMode ?? "keep", cues: draft.cues ?? [], extraInstruction: draft.extra });
              restoredSettings[segment.index] = { ...old, prompt: remapImageReferences(old.prompt, request.imageUrls, (draft.images ?? []).map((image) => image.url)) };
            }
          }
          setSegmentSettings(restoredSettings);
          setClips(draft.clips ?? {});
          setReferenceTrack(draft.referenceTrack ?? null);
          setActiveSegment(draft.activeSegment ?? 0);
          setRuns(Object.fromEntries(Object.entries(draft.runs ?? {}).map(([i, run]) => [i,
            ["preparing", "running", "saving"].includes(run.status) ? { ...run, status: "failed", recoverable: true, error: t("recoverableHint") } : run])));
        } else setRuns({});
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
      setClips({});
      setSegmentSettings({});
      setReferenceTrack(null);
      setActiveSegment(0);
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
    const segs = await transcribe(referenceTrack?.path ?? source.path, source.duration, segments);
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
          { jobId: source.jobId, duration: source.duration, cues, voice: dubVoice, segments, objectStorage },
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
    [source, dubVoice, cues, segments, dubKey, t, objectStorage],
  );

  const setRun = (index: number, patch: SegRun) => setRuns((prev) => ({ ...prev, [index]: { ...prev[index], ...patch } }));

  const settingsFor = (index: number) => segmentSettings[index] ?? defaultSegmentSettings(remakeModel, remakeProvider);
  const audioFor = (index: number) => {
    if (audioMode === "dub") return dubReady ? dub?.segmentAudio[index] : undefined;
    return settingsFor(index).useSourceAudio ? referenceTrack?.segmentAudio[index] ?? clips[index]?.audioPath : undefined;
  };
  const promptFor = (index: number) => {
    const req = requests[index];
    const custom = settingsFor(index).prompt.trim();
    return custom
      ? `${custom}\n字幕要求（以此为准）：${remakeSubtitleInstruction(keepSubtitles, audioMode)}`
      : `${req?.prompt ?? ""}${audioMode !== "dub" && settingsFor(index).useSourceAudio && (source?.hasAudio || referenceTrack) ? "\n使用 @Audio1 作为本段声音和节奏参考，保持音画同步。" : ""}`;
  };
  const keys = requests.map((r) => JSON.stringify({ job: source?.jobId, segment: r.segment,
    prompt: promptFor(r.segment.index), images: r.imageUrls, settings: settingsFor(r.segment.index), audioMode,
    referenceAudio: referenceTrack?.path ?? null, dub: audioMode === "dub" ? {
      voice: [dubVoice?.kind, voiceId, paidConfig?.provider, paidConfig?.model], nextCueStart: [...cues].sort((a, b) => a.start - b.start).find((c) => c.start >= r.segment.end)?.start, cues: cuesForSegment(cues, r.segment).map((c) => [c.start, c.end, c.text]),
    } : null }));
  const gate = firstUnapprovedSegment(keys, runs);
  const current = requests[activeSegment];
  const currentSettings = settingsFor(activeSegment);
  const currentRun = runs[activeSegment];
  // Recover paid tasks on the platform that accepted them, even after settings change.
  const taskModel = currentRun?.recoverable ? currentRun.taskModel ?? currentSettings.model : currentSettings.model;
  const taskProvider = currentRun?.recoverable
    ? currentRun.taskProvider ?? remakeProviderForModel(taskModel)
    : currentSettings.provider || remakeProviderForModel(currentSettings.model);
  const platform = providers[taskProvider];
  const target: ModelTarget | null = platform?.enabled && platform.apiKey
    ? { provider: taskProvider, model: taskModel, apiKey: platform.apiKey, baseUrl: platform.baseUrl }
    : null;
  const currentFresh = currentRun?.key === keys[activeSegment];
  const allApproved = segments.length > 0 && gate === segments.length;
  const canEditCurrent = activeSegment <= gate;
  const currentNeedsEdit = Boolean(current && (current.needsEdit || currentSettings.prompt.trim()));

  const changeImages = (next: RemakeImage[]) => {
    const previous = images.map((image) => image.url), following = next.map((image) => image.url);
    setSegmentSettings((prev) => Object.fromEntries(Object.entries(prev).map(([index, value]) => [index,
      value.prompt ? { ...value, prompt: remapImageReferences(value.prompt, previous, following) } : value])));
    setImages(next); setFinal(null); setAutoSave("draft");
  };
  const audioResourceFor = (index: number) => audioMode !== "dub" ? referenceTrack?.audioResources?.[index] ?? clips[index]?.audioResource : dubReady ? dub?.audioResources?.[index] : undefined;

  const selectSegment = (index: number) => {
    setActiveSegment(index);
    setSelection(segments[index]);
    seek(segments[index].start);
  };
  const replan = (max: number, snap: boolean) => {
    setMaxSeconds(max); setSceneCuts(snap); setClips({}); setRuns({}); setFinal(null);
    setSegmentSettings({}); setReferenceTrack(null); setDub(null); setCues([]); setActiveSegment(0); setSelection(null);
  };
  const prepareSegments = async () => {
    if (!source) return;
    setPreparing(true); setSourceError("");
    try {
      const cut = await postJson<{ segments: SegmentClip[] }>("/api/remake/segments", { jobId: source.jobId, path: source.path, segments, objectStorage });
      setClips(Object.fromEntries(cut.segments.map((clip) => [clip.index, clip])));
      setSelection(segments[activeSegment]);
      setAutoSave("draft");
    } catch (error) { setSourceError((error as Error).message); }
    finally { setPreparing(false); }
  };
  const uploadReferenceAudio = async (file: File) => {
    if (!source) return;
    setUploadingAudio(true); setDubError("");
    try {
      const form = new FormData(); form.append("file", file); form.append("jobId", source.jobId);
      form.append("objectStorage", JSON.stringify(objectStorage)); form.append("duration", String(source.duration)); form.append("segments", JSON.stringify(segments));
      const res = await fetch("/api/remake/reference-audio", { method: "POST", body: form });
      const data = await res.json(); if (!res.ok) throw new Error(data.error);
      setReferenceTrack(data); setCues([]); setDub(null); setFinal(null); setAutoSave("draft");
    } catch (error) { setDubError((error as Error).message); }
    finally { setUploadingAudio(false); }
  };

  // One click can submit exactly one paid segment. Completion always waits for human review.
  const generate = async () => {
    if (!source || running || !current || !canEditCurrent) return;
    const index = activeSegment;
    const key = keys[index];
    const original = clips[index]?.path;
    setRunError("");
    if (!original) return setRunError(t("prepareFirst"));
    if (!storageReady) return setRunError(t("resourceStorageRequired"));
    if (!target && (currentNeedsEdit || currentRun?.recoverable)) return setRunError(t("errorNoModel"));
    if (currentRun?.recoverable && !currentRun.taskId && !currentRun.resultUrl) return setRunError(t("recoverableHint"));
    if (current.imageUrls.some((url) => !url.startsWith("/api/files/") && !/^https?:\/\//i.test(url))) return setRunError(t("referenceNotPortable"));
    if (current.imageUrls.length > remakeMaxImages(currentSettings.model)) return setRunError(t("imagesMax", { max: remakeMaxImages(currentSettings.model) }));
    if (audioMode === "dub" && !dubVoice) return setRunError(t("errorNoVoice"));
    if (audioMode === "dub" && !cues.some((c) => c.text.trim())) return setRunError(t("errorNoCues"));

    const controller = new AbortController(); abortRef.current = controller;
    const { signal } = controller;
    setRunning(true); setFinal(null);
    // Changing an earlier segment requires reviewing later results again, without paying for them again.
    setRuns((prev) => Object.fromEntries(Object.entries(prev).map(([i, run]) => [i, Number(i) >= index ? { ...run, approved: false } : run])));
    let submitted = false;
    let resultUrl = currentRun?.recoverable ? currentRun.resultUrl : undefined;
    let taskId = currentRun?.recoverable ? currentRun.taskId : undefined;
    const resultKey = currentRun?.recoverable ? currentRun.key ?? key : key;
    try {
      const projectId = draftId ?? await saveDraftRef.current("draft");
      if (!projectId) throw new Error(t("draftSaveFailed"));
      if (!currentNeedsEdit && !currentRun?.recoverable) {
        const synced = await postJson<{ resources: ReferenceResource[] }>("/api/remake/resources", { objectStorage, references: [
          { path: clips[index].resource?.id ?? original, label: `${source.label} · ${index + 1}` },
          ...(clips[index].audioPath ? [{ path: clips[index].audioResource?.id ?? clips[index].audioPath!, label: `Audio ${index + 1}` }] : []),
        ] }, signal);
        setClips((prev) => ({ ...prev, [index]: { ...prev[index], resource: synced.resources[0], audioResource: synced.resources[1] } }));
        setRun(index, { status: "skipped", path: synced.resources[0].path, key, approved: false, error: undefined, recoverable: false });
        return;
      }
      setRun(index, { status: "preparing", approved: false, error: undefined, recoverable: false, key: resultKey, taskId, taskModel, taskProvider, resultUrl });
      const dubResult = audioMode === "dub" && !currentRun?.recoverable ? (dubReady && dub ? dub : await buildDub(signal)) : null;
      const audioRef = audioMode === "dub" ? dubResult?.segmentAudio[index] : audioFor(index);
      if (!currentRun?.recoverable && !validPromptReferences(promptFor(index), { image: current.imageUrls.length, video: 1, audio: audioRef ? 1 : 0 })) throw new Error(t("invalidPromptReferences"));
      let videoResource = clips[index].resource;
      let imageResources: ReferenceResource[] = [];
      let audioResource: ReferenceResource | undefined;
      if (!currentRun?.recoverable) {
        const synced = await postJson<{ resources: ReferenceResource[] }>("/api/remake/resources", { objectStorage, references: [
          { path: videoResource?.id ?? original, label: `${source.label} · ${index + 1}` },
          ...images.map((image) => ({ path: image.resource?.id ?? image.url, label: image.label })),
          ...(audioRef ? [{ path: audioResourceFor(index)?.id ?? audioRef, label: `Audio ${index + 1}` }] : []),
        ] }, signal);
        videoResource = synced.resources[0]; imageResources = synced.resources.slice(1, 1 + images.length); audioResource = synced.resources[1 + images.length];
        setClips((prev) => ({ ...prev, [index]: { ...prev[index], resource: videoResource, ...(audioResource && audioMode !== "dub" && !referenceTrack && { audioResource }) } }));
        setImages((prev) => prev.map((image, i) => ({ ...image, resource: imageResources[i] })));
      }
      setRun(index, { status: "running", key: resultKey, approved: false });
      type Generated = { videoUrls?: string[]; taskId?: string; status?: string; error?: string; lastFrameUrl?: string; extra?: { draft_id?: string } };
      let gen: Generated | undefined;
      if (!resultUrl) {
        const pending: SegRun = { status: "running", key: resultKey, approved: false, taskId, taskModel, taskProvider, recoverable: true };
        if (!await saveDraftRef.current("draft", { ...runs, [index]: pending }, projectId)) throw new Error(t("draftSaveFailed"));
        submitted = true;
        gen = taskId
          ? await postJson<Generated>("/api/ai/video/task", { ...target, taskId, wait: true }, signal)
          : await postJson<Generated>("/api/ai/video", {
              ...target, model: currentSettings.model, mode: "video-to-video", prompt: promptFor(index),
              referenceVideoUrls: [videoResource!.url], referenceImageUrls: imageResources.map((resource) => resource.url),
              ...(audioResource && { referenceAudioUrls: [audioResource.url] }),
              referenceResourceIds: { videos: [videoResource!.id], images: imageResources.map((resource) => resource.id), audios: audioResource ? [audioResource.id] : [] },
              objectStorage, projectId, scene: "video_remake", wait: false,
              options: { width: source.width, height: source.height, duration: current.segment.end - current.segment.start,
                audioEnabled: currentSettings.generate_audio, extra: segmentEditParams(currentSettings.model, { ...currentSettings }) },
            }, signal);
        taskId = gen.taskId ?? taskId;
        if (taskId && gen.status === "submitted" && !gen.videoUrls?.length) {
          const resumable = { ...pending, taskId };
          setRun(index, resumable);
          if (!await saveDraftRef.current("draft", { ...runs, [index]: resumable }, projectId)) {
            throw Object.assign(new Error(t("draftSaveFailed")), { recoverable: true, taskId });
          }
          gen = await postJson<Generated>("/api/ai/video/task", { ...target, taskId, wait: true }, signal);
        }
        resultUrl = gen.videoUrls?.[0];
        if (!resultUrl) throw Object.assign(new Error(gen.error || "No video result"), { recoverable: gen.status !== "failed" && gen.status !== "cancelled", taskId });
      }
      const saving: SegRun = { status: "saving", key: resultKey, taskId, taskModel, taskProvider, resultUrl, recoverable: true, approved: false, draftId: gen?.extra?.draft_id ?? (currentRun?.recoverable ? currentRun.draftId : undefined), lastFrameUrl: gen?.lastFrameUrl ?? (currentRun?.recoverable ? currentRun.lastFrameUrl : undefined) };
      setRun(index, saving);
      await saveDraftRef.current("draft", { ...runs, [index]: saving }, projectId);
      const saved = await postJson<{ path: string }>("/api/remake/result", { jobId: source.jobId, index, url: resultUrl, outputFormat: currentSettings.output_format, objectStorage }, signal);
      setRun(index, { status: "done", path: saved.path, key: resultKey, approved: false, error: undefined, recoverable: false,
        resultUrl, taskId, taskModel, taskProvider, draftId: saving.draftId, lastFrameUrl: saving.lastFrameUrl });
    } catch (error) {
      const err = error as Error & { recoverable?: boolean; taskId?: string; code?: string };
      setRun(index, { status: signal.aborted ? "cancelled" : "failed", error: err.message,
        key: resultKey, approved: false, taskId: err.taskId ?? taskId, taskModel, taskProvider, resultUrl,
        recoverable: Boolean(err.recoverable || resultUrl || ((signal.aborted || err instanceof TypeError) && submitted)) });
    } finally {
      setRunning(false); abortRef.current = null; setAutoSave("draft");
    }
  };

  const approveCurrent = () => {
    if (!currentRun?.path || !currentFresh || running || !canEditCurrent || !["done", "skipped"].includes(currentRun.status)) return;
    setRun(activeSegment, { ...currentRun, approved: true });
    if (activeSegment + 1 < segments.length) selectSegment(activeSegment + 1);
    setAutoSave("draft");
  };
  const assemble = async () => {
    if (!source || running || !allApproved) return;
    setRunning(true); setAssembling(true); setRunError("");
    const controller = new AbortController(); abortRef.current = controller;
    try {
      const dubResult = audioMode === "dub" ? (dubReady && dub ? dub : await buildDub(controller.signal)) : null;
      const result = await postJson<FinalResult>("/api/remake/finalize", { jobId: source.jobId, sourcePath: source.path,
        segments: segments.map((seg) => ({ ...seg, path: runs[seg.index].path, edited: runs[seg.index].status === "done" })),
        audioMode, dubPath: dubResult?.dubPath, title: t("titleDefault", { name: source.label }),
        description: requests.map((r) => promptFor(r.segment.index).split("\n")[0]).join("\n"),
      }, controller.signal);
      setFinal(result); setAutoSave("done");
    } catch (error) { setRunError((error as Error).message); }
    finally { setRunning(false); setAssembling(false); abortRef.current = null; }
  };

  const marks: TimelineMark[] = ops.flatMap((op, i) => (op.range ? [{ id: op.id, start: op.range.start, end: op.range.end, label: `${i + 1}. ${t(`opKind_${op.kind}`)}` }] : []));

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
            <span className={`rounded-full px-2 py-0.5 font-mono ${target ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>
              {target ? `${currentSettings.model} · ${target.provider}` : t("modelNone")}
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
            <Button variant="outline" size="sm" disabled={savingDraft || restoring || running || preparing || uploadingImages || uploadingAudio || dubbing} onClick={() => void saveDraft()}>
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
          {!storageReady && <p className="mt-2 text-xs text-amber-600">{t("resourceStorageRequired")} <Link href="/settings?tab=storage" className="text-primary hover:underline">{t("modelConfigure")}</Link></p>}
          {!target && <p className="mt-2 text-xs text-amber-600">{t("errorNoModel")}</p>}
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
                <Button variant="outline" onClick={() => setPickerOpen(true)} disabled={loadingSource || running || preparing || uploadingImages || uploadingAudio || dubbing || transcribeState.phase === "loading" || transcribeState.phase === "transcribing"}>
                  <LuFolderOpen />
                  {source ? t("replaceSource") : t("pickLibrary")}
                </Button>
                <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={loadingSource || running || preparing || uploadingImages || uploadingAudio || dubbing || transcribeState.phase === "loading" || transcribeState.phase === "transcribing"}>
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
                      {segments.length > 1 ? t("segmentsDesc", { max: maxSeconds, count: segments.length }) : t("segmentsSingle")}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <label>{t("maxSegmentLength")} <select value={maxSeconds} disabled={Object.keys(runs).length > 0 || running || preparing || uploadingImages || uploadingAudio || dubbing || savingDraft || transcribeState.phase !== "idle" && transcribeState.phase !== "error"}
                        onChange={(e) => replan(Number(e.target.value), sceneCuts)} className="rounded border border-input bg-background p-1">
                        <option value={10}>10s</option><option value={8}>8s</option>
                      </select></label>
                      <label className="flex items-center gap-1"><input type="checkbox" checked={sceneCuts} disabled={Object.keys(runs).length > 0 || running || preparing || uploadingImages || uploadingAudio || dubbing || transcribeState.phase === "loading" || transcribeState.phase === "transcribing"}
                        onChange={(e) => replan(maxSeconds, e.target.checked)} />{t("sceneCuts")}</label>
                      <Button variant="outline" size="sm" disabled={running || preparing} onClick={() => void prepareSegments()}>{preparing ? <LuLoaderCircle className="animate-spin" /> : <LuPlay />}{Object.keys(clips).length ? t("segmentsPrepared") : t("prepareSegments")}</Button>
                    </div>
                    {segments.length > 1 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {segments.map((s) => (
                          <button
                            key={s.index}
                            type="button"
                            onClick={() => selectSegment(s.index)}
                            disabled={running || uploadingImages || s.index > gate}
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

        {/* Step 3 — subtitles & audio */}
        <section className={`mb-10 ${source ? "" : "pointer-events-none opacity-50"}`}>
          <StepHeader n={2} title={t("step3Title")} active={Boolean(source)} />
          <Card className="glass-card">
            <CardContent className="p-4 sm:p-6">
              <fieldset disabled={running || uploadingImages || uploadingAudio || dubbing || transcribeState.phase === "loading" || transcribeState.phase === "transcribing"} className="space-y-4">
              <p className="text-xs text-muted-foreground">{t("alignedAudioHint")}</p>
              <input ref={audioFileRef} type="file" accept="audio/wav,audio/mpeg,.wav,.mp3" className="hidden" onChange={(e) => {
                const file = e.target.files?.[0]; e.target.value = ""; if (file) void uploadReferenceAudio(file);
              }} />
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => audioFileRef.current?.click()}>{t("uploadReferenceAudio")}</Button>
                <Button variant="outline" size="sm" disabled={!source?.hasAudio && !referenceTrack} onClick={() => void runTranscribe()}>{t("transcribeSegments")}</Button>
                {referenceTrack && <Button variant="ghost" size="sm" onClick={() => { setReferenceTrack(null); setCues([]); setDub(null); setFinal(null); }}>{t("removeReferenceAudio")}</Button>}
              </div>
              <AudioPanel
                keepSubtitles={keepSubtitles}
                onKeepSubtitlesChange={(value) => { setKeepSubtitles(value && canKeepRemakeSubtitles(audioMode)); setFinal(null); }}
                audioMode={audioMode}
                onAudioModeChange={(value) => { setAudioMode(value); if (!canKeepRemakeSubtitles(value)) setKeepSubtitles(false); setFinal(null); }}
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
                hasAudio={Boolean(source?.hasAudio || referenceTrack)}
                currentTime={currentTime}
                transcribeState={transcribeState}
                onTranscribe={() => void runTranscribe()}
                dubbing={dubbing}
                dubReady={dubReady}
                dubPath={dub?.dubPath ?? null}
                onBuildDub={() => void buildDub().catch(() => {})}
              />
              </fieldset>
              {transcribeState.phase === "loading" || transcribeState.phase === "transcribing" ? <p className="mt-2 text-xs">{t("cuesTranscribing", { progress: transcribeState.progress })}</p> : transcribeState.phase === "error" ? <p className="mt-2 text-xs text-destructive">{transcribeState.error}</p> : null}
              {dubError && <p className="mt-3 text-xs text-destructive">{dubError}</p>}
            </CardContent>
          </Card>
        </section>

        {/* Step 4 — review exactly one segment at a time */}
        <section className={`mb-10 ${source ? "" : "pointer-events-none opacity-50"}`}>
          <StepHeader n={3} title={t("step4Title")} desc={t("reviewWorkflow")} active={Boolean(source)} />
          <Card className="glass-card">
            <CardContent className="space-y-4 p-4 sm:p-6">
              <div className="flex flex-wrap gap-2">
                {segments.map((seg) => <Button key={seg.index} size="sm" variant={activeSegment === seg.index ? "secondary" : "outline"}
                  disabled={running || uploadingImages || seg.index > gate} onClick={() => selectSegment(seg.index)}>
                  {isSegmentApproved(runs[seg.index], keys[seg.index]) && <LuCheck />}{t("segmentLabel", { n: seg.index + 1 })}
                </Button>)}
              </div>
              {current && <>
                <p className="text-sm font-medium">{t("promptSegment", { n: activeSegment + 1, start: current.segment.start.toFixed(3), end: current.segment.end.toFixed(3) })}</p>
                {clips[activeSegment]?.resource && <p className="break-all text-xs text-muted-foreground">MD5 · {clips[activeSegment].resource?.md5} · {t("resourceCloudReady")}</p>}
                <div className="grid gap-3 sm:grid-cols-2">
                  <figure className="space-y-2"><figcaption className="text-xs text-muted-foreground">{t("compareSource")}</figcaption>
                    {clips[activeSegment]?.path ? <video key={clips[activeSegment].path} src={clips[activeSegment].path} controls playsInline className="max-h-80 w-full rounded-lg bg-black" /> : <p className="text-xs">{t("prepareFirst")}</p>}
                    {audioFor(activeSegment) && <audio src={audioFor(activeSegment)} controls className="w-full" />}
                    <div className="text-xs text-muted-foreground">{cuesForSegment(cues, current.segment).map((cue) => <p key={cue.id}>{cue.start.toFixed(1)}–{cue.end.toFixed(1)}s · {cue.text}</p>)}</div>
                  </figure>
                  <figure className="space-y-2"><figcaption className="text-xs text-muted-foreground">{t("compareResult")}</figcaption>
                    {currentRun?.path && <video key={currentRun.path} src={currentRun.path} controls playsInline className="max-h-80 w-full rounded-lg bg-black" />}
                    <p className="text-xs text-muted-foreground">{t(`seg_${currentRun?.status ?? "idle"}`)}</p>
                    {currentRun?.path && !currentFresh && <p className="text-xs text-amber-600">{t("segmentStale")}</p>}
                    {currentRun?.draftId && <p className="break-all text-xs">draft_id: {currentRun.draftId}</p>}
                    {currentRun?.lastFrameUrl && <a href={currentRun.lastFrameUrl} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">{t("openLastFrame")}</a>}
                    {currentRun?.error && <p className="whitespace-pre-wrap text-xs text-destructive">{currentRun.error}</p>}
                  </figure>
                </div>
                <fieldset disabled={running || !canEditCurrent || uploadingImages} className="space-y-4">
                  <ReferenceImages images={images} onChange={changeImages} maxImages={remakeMaxImages(currentSettings.model)} onBusy={setUploadingImages} />
                  <SegmentParams value={currentSettings} enabledProviders={Object.keys(providers).filter((p) => providers[p]?.enabled && providers[p]?.apiKey)} onChange={(value) => { setSegmentSettings((prev) => ({ ...prev, [activeSegment]: value })); setFinal(null); }}
                    requestPrompt={promptFor(activeSegment)}
                    prompt={current.prompt + (audioMode !== "dub" && currentSettings.useSourceAudio && (source?.hasAudio || referenceTrack) ? "\n使用 @Audio1 作为本段声音和节奏参考，保持音画同步。" : "")}
                    video={clips[activeSegment]?.resource?.url ?? clips[activeSegment]?.path}
                    images={images.map((image) => image.resource?.url ?? image.url)} audio={audioFor(activeSegment) ? audioResourceFor(activeSegment)?.url ?? audioFor(activeSegment) : undefined}
                    references={[
                      ...images.map((image, i) => ({ token: `@Image${i + 1}`, kind: "image" as const, label: image.label })),
                      ...(clips[activeSegment] ? [{ token: "@Video1", kind: "video" as const, label: t("segmentLabel", { n: activeSegment + 1 }) }] : []),
                      ...(audioFor(activeSegment) ? [{ token: "@Audio1", kind: "audio" as const, label: t(audioMode === "dub" ? "audio_dub" : referenceTrack ? "uploadedAudio" : "audio_keep") }] : []),
                    ]} />
                </fieldset>
                <div className="flex flex-wrap items-center gap-2">
                  <Button className="brand-gradient text-white" disabled={running || !canEditCurrent || !storageReady || !clips[activeSegment] || preparing || uploadingAudio || uploadingImages || dubbing || savingDraft ||
                    (transcribeState.phase === "loading" || transcribeState.phase === "transcribing") ||
                    Boolean(currentRun?.recoverable && !currentRun.taskId && !currentRun.resultUrl)} onClick={() => void generate()}>
                    {running ? <LuLoaderCircle className="animate-spin" /> : currentRun?.path ? <LuRefreshCw /> : <LuSparkles />}
                    {running ? (assembling ? t("assembling") : t("generating")) : currentRun?.recoverable ? t("recoverSegment") : !currentNeedsEdit ? t("reuseSegment") : currentRun?.path ? t("regenerateSegment") : t("generateSegment")}
                  </Button>
                  <Button variant="outline" disabled={running || uploadingImages || !canEditCurrent || !currentFresh || !currentRun?.path || !["done", "skipped"].includes(currentRun.status)} onClick={approveCurrent}>
                    <LuCheck />{t("approveSegment")}
                  </Button>
                  {running && <Button variant="outline" onClick={() => abortRef.current?.abort()}>{t("cancel")}</Button>}
                  <span className="text-xs text-muted-foreground">{t("estimate", { seconds: Number((current.segment.end - current.segment.start).toFixed(3)) })}</span>
                </div>
              </>}
              {runError && <p className="flex items-start gap-1 text-xs text-destructive"><LuCircleAlert className="size-4 shrink-0" />{runError}</p>}
              <div className="border-t border-border/60 pt-4">
                <Button variant="secondary" disabled={!allApproved || running} onClick={() => void assemble()}>{assembling ? <LuLoaderCircle className="animate-spin" /> : <LuDownload />}{t("assembleApproved")}</Button>
                <p className="mt-2 text-xs text-muted-foreground">{t("approvalProgress", { count: gate, total: segments.length })}</p>
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Step 5 — result */}
        {final && source && (
          <section className="mb-10">
            <StepHeader n={4} title={t("step5Title")} active />
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
