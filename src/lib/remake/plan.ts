/**
 * 视频复刻 (video remake) planning — pure functions, no I/O.
 *
 * A remake edits an existing clip with Seedance's video-edit mode: the source clip rides along as
 * `@视频1`, replacement looks come in as `@图片n`, and the model keeps everything the prompt does
 * not touch (camera, motion, timing, subtitles). Three things make that more than one call:
 *
 *  - Edit mode only takes a 4–30s clip and is most stable at ≤15s, so a longer source is cut into
 *    segments that are edited one by one and concatenated back. Cuts snap to the clip's own scene
 *    changes when one is close, so the seam lands where the footage already cuts.
 *  - Each segment sees only the edits whose time range overlaps it, with that range rewritten to
 *    segment-local seconds, and only the reference images those edits use (renumbered from 1, since
 *    Ark numbers references by their order in the request).
 *  - A segment with nothing to change is not sent at all: the original footage is reused as is.
 */

export const REMAKE_MIN_SEGMENT_SEC = 4;
/** Edit mode accepts up to 30s, but stability (and reference audio) holds best at ≤15s */
export const REMAKE_MAX_SEGMENT_SEC = 15;
/** How far a planned cut may move to land on a detected scene change */
export const REMAKE_SCENE_SNAP_SEC = 2;
/** Ark takes at most 9 reference images per request */
export const REMAKE_MAX_IMAGES = 9;

export interface TimeSpan {
  start: number;
  end: number;
}

export interface RemakeSegment extends TimeSpan {
  index: number;
}

export type RemakeOpKind = "product" | "person" | "background" | "custom";

export interface RemakeOp {
  id: string;
  kind: RemakeOpKind;
  /** What to replace in the source, e.g. "坐着的演员" / "桌上的白色杯子" (empty = the kind's default) */
  target: string;
  /** Reference image this edit takes its new look from (id into the image list) */
  imageId?: string;
  /** Extra wording; the whole instruction for a custom edit */
  detail: string;
  /** Absolute source seconds; absent = the whole clip */
  range?: TimeSpan;
}

export interface RemakeImage {
  id: string;
  /** Local /api/files path, http(s) URL, or an Ark portrait asset (asset://<id>) */
  url: string;
  label: string;
  /** Preview for an asset:// reference (the photo it was registered from) */
  thumbUrl?: string;
}

export type RemakeAudioMode = "keep" | "mute" | "dub";

export interface DubCue extends TimeSpan {
  id: string;
  text: string;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Cut a clip into editable segments of [min, max] seconds. Boundaries start evenly spaced and move
 * to the nearest scene change within REMAKE_SCENE_SNAP_SEC, as long as every remaining segment can
 * still be sized within bounds. Throws RangeError("TOO_SHORT") below the model's minimum.
 */
export function planSegments(
  duration: number,
  options: { maxSeconds?: number; minSeconds?: number; sceneTimes?: number[] } = {},
): RemakeSegment[] {
  const max = options.maxSeconds ?? REMAKE_MAX_SEGMENT_SEC;
  const min = options.minSeconds ?? REMAKE_MIN_SEGMENT_SEC;
  if (!Number.isFinite(duration) || duration < min) throw new RangeError("TOO_SHORT");
  const total = round3(duration);
  if (total <= max) return [{ index: 0, start: 0, end: total }];

  const count = Math.ceil(total / max);
  const scenes = (options.sceneTimes ?? []).filter((t) => Number.isFinite(t) && t > 0 && t < total);
  const bounds: number[] = [0];
  for (let k = 1; k < count; k++) {
    const prev = bounds[k - 1];
    const left = count - k; // segments still to place after this cut
    const ideal = prev + (total - prev) / (left + 1);
    // the cut must leave this segment and every later one within [min, max]
    const lo = Math.max(prev + min, total - left * max);
    const hi = Math.min(prev + max, total - left * min);
    let cut = Math.min(hi, Math.max(lo, ideal));
    let best = Infinity;
    for (const t of scenes) {
      const distance = Math.abs(t - ideal);
      if (distance <= REMAKE_SCENE_SNAP_SEC && t >= lo && t <= hi && distance < best) {
        best = distance;
        cut = t;
      }
    }
    bounds.push(round3(cut));
  }
  bounds.push(total);
  return bounds.slice(0, -1).map((start, index) => ({ index, start, end: bounds[index + 1] }));
}

/** Overlap of a span with a segment, in segment-local seconds; null when they do not overlap */
export function localSpan(span: TimeSpan, segment: TimeSpan): TimeSpan | null {
  const start = Math.max(span.start, segment.start);
  const end = Math.min(span.end, segment.end);
  if (end - start < 0.05) return null;
  return { start: round3(start - segment.start), end: round3(end - segment.start) };
}

/** Edits that touch a segment (whole-clip edits always do) */
export function opsForSegment(ops: RemakeOp[], segment: TimeSpan): RemakeOp[] {
  return ops.filter((op) => !op.range || localSpan(op.range, segment) !== null);
}

export function cuesForSegment(cues: DubCue[], segment: TimeSpan): DubCue[] {
  return cues.filter((cue) => localSpan(cue, segment) !== null);
}

/** An edit is usable once it says what to put in: an image, or words */
export function isOpComplete(op: RemakeOp): boolean {
  if (op.kind === "custom") return op.detail.trim().length > 0;
  return Boolean(op.imageId) || op.detail.trim().length > 0;
}

/** "16-20秒" / "3.5-8秒" */
function formatSeconds(n: number): string {
  return String(Math.round(n * 10) / 10);
}

/** `@图片N` tokens a custom instruction mentions, by their global number */
const IMAGE_TOKEN = /@图片(\d+)/g;

function customImageIds(op: RemakeOp, images: RemakeImage[]): string[] {
  const ids: string[] = [];
  for (const match of op.detail.matchAll(IMAGE_TOKEN)) {
    const image = images[Number(match[1]) - 1];
    if (image) ids.push(image.id);
  }
  return ids;
}

function opSentence(op: RemakeOp, imageNo: (id: string) => number | undefined, images: RemakeImage[]): string {
  const detail = op.detail.trim();
  const target = op.target.trim();
  const n = op.imageId ? imageNo(op.imageId) : undefined;
  const extra = detail ? `，${detail}` : "";
  switch (op.kind) {
    case "product":
      return n
        ? `将 @视频1 中的${target || "商品"}替换为 @图片${n} 中的商品，新商品沿用原商品出现的时间点、手部动作与运动轨迹${extra}`
        : `将 @视频1 中的${target || "商品"}替换为${detail}`;
    case "person":
      return n
        ? `将 @视频1 中的${target || "人物"}换成 @图片${n} 中的人物，保留原人物的动作、表情节奏与站位${extra}`
        : `将 @视频1 中的${target || "人物"}换成${detail}，保留原人物的动作、表情节奏与站位`;
    case "background":
      return n
        ? `将 @视频1 ${target ? `中${target}的` : "的"}背景替换为 @图片${n} 中的场景，人物与前景保持不变${extra}`
        : `将 @视频1 ${target ? `中${target}的` : "的"}背景替换为${detail}，人物与前景保持不变`;
    case "custom":
      // rewrite the user's global @图片N to this request's numbering
      return detail.replace(IMAGE_TOKEN, (token, raw: string) => {
        const image = images[Number(raw) - 1];
        const local = image ? imageNo(image.id) : undefined;
        return local ? `@图片${local}` : token;
      });
  }
}

const IMAGE_ROLE: Record<RemakeOpKind, string> = {
  product: "只提供新商品的外观、结构与材质",
  person: "只提供人物的外貌与服装",
  background: "只提供新背景的场景",
  custom: "只作为参考",
};

export interface SegmentRequest {
  segment: RemakeSegment;
  /** false = nothing to change here; the original footage is reused */
  needsEdit: boolean;
  prompt: string;
  /** Reference images for this request, in @图片1… order */
  imageUrls: string[];
  /** Whether the segment's slice of the dub track rides along as @音频1 */
  useDubAudio: boolean;
  /** Edits included, for display */
  opIds: string[];
}

/**
 * The prompt and references for one segment, following the Seedance 2.5 edit-prompt shape: trigger
 * word first, then each change, then what @视频1 keeps and what each @图片 may contribute.
 */
export function buildSegmentRequest(input: {
  segment: RemakeSegment;
  ops: RemakeOp[];
  images: RemakeImage[];
  keepSubtitles: boolean;
  audioMode: RemakeAudioMode;
  cues: DubCue[];
  /** Applies to every segment, appended verbatim */
  extraInstruction?: string;
}): SegmentRequest {
  const { segment, images } = input;
  const ops = opsForSegment(input.ops.filter(isOpComplete), segment);
  const useDubAudio = input.audioMode === "dub" && cuesForSegment(input.cues, segment).some((c) => c.text.trim());
  const extra = input.extraInstruction?.trim() ?? "";

  // images in order of first use, renumbered from 1 for this request
  const order: string[] = [];
  const roles = new Map<string, RemakeOpKind>();
  for (const op of ops) {
    const ids = op.kind === "custom" ? customImageIds(op, images) : op.imageId ? [op.imageId] : [];
    for (const id of ids) {
      if (!images.some((img) => img.id === id)) continue;
      if (!order.includes(id)) order.push(id);
      if (!roles.has(id)) roles.set(id, op.kind);
    }
  }
  const used = order.slice(0, REMAKE_MAX_IMAGES);
  const imageNo = (id: string) => {
    const i = used.indexOf(id);
    return i >= 0 ? i + 1 : undefined;
  };

  const needsEdit = ops.length > 0 || useDubAudio;
  const span = segment.end - segment.start;
  const changes = ops.map((op) => {
    const local = op.range ? localSpan(op.range, segment) : null;
    const whole = !local || (local.start <= 0.05 && local.end >= span - 0.05);
    const prefix = whole ? "" : `${formatSeconds(local.start)}-${formatSeconds(local.end)}秒，`;
    return prefix + opSentence(op, imageNo, images);
  });

  const lines: string[] = [];
  if (changes.length) lines.push(`编辑视频：${changes.join("；")}。`);
  else if (useDubAudio) lines.push("编辑视频：只调整人物口型，使其与 @音频1 的语音同步。");
  lines.push("以 @视频1 为母版，保留原视频的场景、运镜、构图、人物动作、节奏与事件顺序，除上述修改外，视频其他部分的运镜和细节都不改变。");
  used.forEach((id, i) => {
    lines.push(`@图片${i + 1} ${IMAGE_ROLE[roles.get(id) ?? "custom"]}，不采用其背景、构图与光线。`);
  });
  lines.push(
    input.keepSubtitles
      ? "保留原视频中的字幕，字幕的文字、位置、字体与出现时间保持不变。"
      : "去掉画面中的字幕，其他内容不变。",
  );
  if (useDubAudio) lines.push("人物说话时的口型与 @音频1 的语音同步，说话节奏跟随 @音频1。");
  if (extra) lines.push(extra);

  return {
    segment,
    needsEdit,
    prompt: lines.join("\n"),
    imageUrls: used.map((id) => images.find((img) => img.id === id)!.url),
    useDubAudio,
    opIds: ops.map((op) => op.id),
  };
}

/**
 * Turn word-level ASR segments into dub cues: drop empties, clamp to the clip, and keep them in
 * order without overlap so each cue owns its slot on the timeline.
 */
export function cuesFromTranscript(segments: Array<{ start: number; end: number; text: string }>, duration: number): DubCue[] {
  const sorted = segments
    .map((s) => ({ start: Math.max(0, s.start), end: Math.min(duration, s.end), text: s.text.replace(/\s+/g, " ").trim() }))
    .filter((s) => s.text && s.end - s.start > 0.05)
    .sort((a, b) => a.start - b.start);
  const out: DubCue[] = [];
  for (const s of sorted) {
    const prev = out[out.length - 1];
    const start = prev ? Math.max(s.start, prev.end) : s.start;
    if (s.end - start < 0.05) continue;
    out.push({ id: `cue${out.length + 1}`, start: round3(start), end: round3(s.end), text: s.text });
  }
  return out;
}

/**
 * Where each dub line plays and how much it must be sped up to fit before the next line starts
 * (or the clip ends). Speed-up is capped; anything still too long is cut at the slot end.
 */
export function placeDubCues(
  cues: Array<DubCue & { audioSeconds: number }>,
  duration: number,
  maxSpeedup = 1.35,
): Array<{ id: string; start: number; slot: number; tempo: number }> {
  return cues.map((cue, i) => {
    const next = cues[i + 1]?.start ?? duration;
    const slot = Math.max(0.1, next - cue.start);
    const tempo = cue.audioSeconds > slot ? Math.min(maxSpeedup, cue.audioSeconds / slot) : 1;
    return { id: cue.id, start: cue.start, slot: round3(slot), tempo: Math.round(tempo * 1000) / 1000 };
  });
}
