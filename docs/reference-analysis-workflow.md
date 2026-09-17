# 爆款拆解流水线（方案）

> **状态：第 1 批（S0–S2）已实现，第 2、3 批（S3–S6）尚未开始。** 文中「现状」描述的是动工前的代码；已落地的部分见文末「第 1 批落地情况」。

## 为什么要做

今天的「载入结构参考」只解析了一件事：**镜头数和每镜时长**。

上传视频走 `POST /api/replicate/analyze`，四步：存盘 → `probeMedia` 拿时长分辨率 → `detectSceneTimes` 用 ffmpeg 的 `select='gt(scene,0.22)'` 找切点 → `shotPlanFromCuts` 把切点整理成镜头表（合并 <1s 碎片、超过 12 镜就并掉最短的）。最后 `replicateReferenceStructure` 拼出一段话喂给脚本生成：

> 以下节奏骨架来自一条参考爆款视频的真实镜头切分（共 3 镜、全长约 9s）：第1镜 3s、第2镜 3s、第3镜 3s。……**不要照搬参考内容，只复刻节奏与结构。**

节奏是真的。但除此之外——画面、口播、钩子、卖点顺序、CTA 位置——一个字都没解析，全靠 AI 拿着商品自由发挥。

只填链接的那条路更直接：`setTimeout(600)` 装个加载，然后返回**硬编码的 6 张卡片**。UI 文案是诚实的（「暂不支持解析视频画面内容」），但它和你贴的那条视频没有任何关系。

模型档（Seedance reference-to-video）是唯一真正「看见」原片的路径，可它是个黑盒：一次调用出成片，中间没有任何可检查、可修改的东西。

| | 现状 |
|---|---|
| 节奏（镜头数、时长） | ✅ 真的 |
| 画面（景别/运镜/主体/色调/转场） | ❌ |
| 口播文案、字幕、钩子 | ❌ |
| 卖点顺序、证据类型、CTA 位置 | ❌ |
| 情绪曲线、切换密度 | ❌ |
| 链接输入 | ❌ 固定模板 |

一条视频「为什么爆」，几乎全在没解析的那几行里。

## 零件基本都有

这套东西不用从零造，仓库里已经躺着大半：

| 能力 | 已有 | 位置 |
|---|---|---|
| 时长 / 分辨率 / 帧率 / 有无音轨 | ✅ | `probeMedia`（`src/lib/media-probe.ts`） |
| 场景切点检测 | ✅ | `detectSceneTimes`（`src/lib/video-composer/contact-sheet.ts`） |
| 按切点智能抽帧拼图，带时间戳标注 | ✅ | `generateContactSheet`（同上） |
| 视觉模型读图 → 主体/光线/色调/运镜/节奏 | ✅ | `analyzeVisualMedia`（`src/lib/media-analysis.ts`），`/api/media/analyze` 在用 |
| 浏览器端 whisper ASR | ✅ | transcript 页（`src/lib/local-asr.ts`） |
| 分阶段、可断点续跑的服务端编排 | ✅ | `pipeline_runs` + `src/lib/pipeline-runner.ts` |
| 每步耗时与花费 | ✅ | `api_calls`（`/api-logs`），PR #5 |
| 参考片来源：上传 / 素材库 | ✅ | `LibraryVideoPicker` + `/api/replicate/analyze`，PR #10 |

✅ = 已在 `main`；🔜 = 已实现、还在待合的 PR 里。

缺的只是**把它们串起来，并且把中间态暴露出来**。

## 流水线

```
S0 载入 ──→ S1 切分 ──→ S2 取帧 ──→ S3 读画面 ──┐
                            └──→ S4 听声音 ──────┴──→ S5 归纳结构 ──→ S6 生成参考
```

| 步 | 做什么 | 产出 | 人工能改什么 | 成本 |
|---|---|---|---|---|
| **S0 载入** | 上传 / 素材库选片 | 本地路径、时长、分辨率、帧率、竖横屏、有无人声 | 换源 | 免费 |
| **S1 切分** | `detectSceneTimes` + `shotPlanFromCuts` | 镜头表 `[{i, start, dur}]` | 拖切点、合并/拆分镜头、调阈值重跑 | 免费 |
| **S2 取帧** | 每镜首/中/末帧 + 整片 contact sheet | 每镜 3 张关键帧 | 换某镜的代表帧 | 免费 |
| **S3 读画面** | 每镜关键帧喂 `analyzeVisualMedia` | 每镜：景别、运镜、主体、光线、色调、转场、画面文字 | 逐字段改写 | 视觉模型 |
| **S4 听声音** | ASR 出逐句+时间戳；ffmpeg 出响度/静音段 | 口播稿按镜对齐、语速、停顿点、切换密度曲线 | 改句子、改对齐 | ASR 免费（浏览器） |
| **S5 归纳结构** | 一次 LLM，吃 S1–S4 全表 | 「为什么爆」的结构化解读 | 每个字段都能改 | 文本模型 |
| **S6 生成参考** | S5 结构 + 你的商品 | `referenceStructure v2` → 现有脚本生成 | 改完重出 | 文本模型 |

### S5 才是真正的「视频参考」

不再是一串时长，而是：

```jsonc
{
  "hook": { "type": "结果前置", "seconds": 2.4, "line": "三天就把它用完了" },
  "emotionCurve": [ { "shot": 1, "tension": 85 }, { "shot": 2, "tension": 40 } ],
  "beats": [
    { "shot": 1, "role": "钩子", "shotSize": "大特写", "camera": "手持推近",
      "evidence": "口播", "duration": 2.4 },
    { "shot": 2, "role": "痛点", "shotSize": "中景", "camera": "固定",
      "evidence": "场景演示", "duration": 3.1 },
    { "shot": 5, "role": "CTA", "shotSize": "特写", "camera": "固定",
      "evidence": "字幕+口播", "duration": 1.8 }
  ],
  "pacing": { "avgShotSec": 2.6, "shortestSec": 1.2, "cutsPerSecond": 0.38 },
  "sellingPointOrder": ["便携", "见效快", "价格"],
  "ctaPosition": "末镜 + 第3镜口播埋一次"
}
```

拿这个去生成脚本，AI 知道的就不只是「第2镜给我 3 秒」，而是「第2镜是痛点位、中景、固定机位、用场景演示而不是口播、3 秒」。

## 工程形态

**一步一个 route**：`POST /api/replicate/analyze/{cut|frames|vision|audio|structure|reference}`。照抄 `pipeline-runner.ts` 已经验证过的做法——每个阶段走自己的 HTTP 路由，编排层不重复实现任何内部逻辑。

**一张表** `reference_analyses`：每步一个 JSON 列，外加一个 `staleFrom` 标记。

```ts
export const referenceAnalyses = sqliteTable("reference_analyses", {
  id: text("id").primaryKey(),
  projectId: text("project_id"),        // 可空：拆解可以先于项目存在
  sourcePath: text("source_path").notNull(),
  ingest:    text("ingest",    { mode: "json" }),  // S0
  cuts:      text("cuts",      { mode: "json" }),  // S1
  frames:    text("frames",    { mode: "json" }),  // S2
  vision:    text("vision",    { mode: "json" }),  // S3
  audio:     text("audio",     { mode: "json" }),  // S4
  structure: text("structure", { mode: "json" }),  // S5
  reference: text("reference", { mode: "json" }),  // S6
  // 改了哪一步，它和它下游就算过期；已有结果不删，随时能比对
  staleFrom: text("stale_from"),
  createdAt: integer("created_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }),
});
```

**每步可单独重跑**，这是整个设计的重点。视觉模型把一个景别看错了，不该逼你从头再来一遍。改了 S1 的切点，S2–S6 自动标 stale 待重跑，旧结果保留。

**「让 AI 改这一步」**：把该步输出 + 一句自然语言指令交给 LLM（「第3镜其实是对比不是演示」），只改这一步，不动别的。

**降级要诚实**：S3/S5 需要视觉/文本模型，没配就跳过，并在卡片上明确标「未解析」——**绝不用通用模板冒充解析结果**。今天链接输入那 6 张假卡片就是反面教材：它让人以为系统读懂了原片，其实什么都没读。

所以免费档能拿到 S0–S2 + S4（纯 ffmpeg + 浏览器 ASR），已经比今天强很多；完整档才有 S3/S5。

## UI

左边步骤导轨，每步显示状态、耗时、花费、用的哪个模型；右边是当前步骤的数据面板（表格或卡片，就地可编辑）。下游步骤 stale 时在导轨上变灰，挂一个「重跑」。

每步面板右上角一个「让 AI 改这一步」，点开是个输入框。

## 实现顺序

建议分三批，每批都能独立上线：

1. **S1 + S2**（纯 ffmpeg，零模型成本）——切分可调 + 关键帧可见。做完「参考」就从一串数字变成看得见的东西了，且完全不动现有链路。
2. **S3 + S5**——接上视觉模型和结构归纳，`referenceStructure v2` 上线，脚本生成开始吃结构而不只是时长。
3. **S4 + S6**——口播对齐与逐镜改写。

第 1 批是性价比最高的：不花一分钱模型费，却把「AI 到底看到了什么」这件事从不可见变成可编辑。

## 第 1 批落地情况

爆款复刻页载入参考视频后，原来那排「第 N 镜」卡片换成了分步拆解面板（`ReferenceAnalysisPanel`）：左边是 S0–S2 的步骤导轨（状态、耗时、免费），右边是当前步骤的数据，就地可改。

| 步 | 接口 | 做了什么 |
|---|---|---|
| S0 + S1 | `POST /api/replicate/analyze`（原接口） | 上传或素材库选片（`ingest.source` 记来源）；除原有返回字段外，把载入与切分结果写进 `reference_analyses`，带回 `analysisId` |
| — | `GET /api/replicate/analyze?id=` | 读回整条拆解 |
| S1 | `POST /api/replicate/analyze/cut` | `{ threshold }` 按新阈值重新检测；`{ cuts }` 存手改的切点（拖动、在播放位置切分、与下一镜合并）。手改的切点不再做 <1s 合并和 12 镜封顶，上限 40 镜 |
| S2 | `POST /api/replicate/analyze/frames` | 每镜首/中/末帧（720px）+ 按当前切点标注的整片联系表；`{ shotIndex, representative }` 换代表帧；`{ shotIndex, time }` 在播放位置补取一帧并设为代表帧 |

和设计稿的几处取舍：

- **过期规则**集中在 `staleFromAfterWrite`（`src/lib/reference-analysis.ts`）：重跑一步会清掉它自己的过期标记，手改不会——在过期的关键帧里挑代表帧，不能让它们变「新」。重新检测若得到完全相同的切点，下游保持原状。
- **切点修订号**：S1 每写一次 `revision` +1，S2 记下自己取帧时的修订号。取帧途中切点被改了，结果照存，但直接标为过期。
- **不自动重跑**：切点改了只标 S2 过期、给「重新取帧」按钮；只有新载入的参考片会自动取一次帧。
- 脚本生成吃的 `referenceStructure` 按**当前**切点重新生成，所以手改切点会直接影响后面生成的脚本。
- 重新取帧会删掉上一轮的帧文件；拆解记录本身目前不清理。

