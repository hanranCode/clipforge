# 视频复刻：Atlas Cloud Seedance / Wan

`/project/remake` 的视频编辑固定使用 Atlas Cloud，支持以下模型：

- `bytedance/seedance-2.5/reference-to-video`（默认）
- `bytedance/seedance-2.0/reference-to-video`
- `alibaba/wan-3.0/reference-to-video`
- `alibaba/wan-3.0-prime/reference-to-video`

在「设置 → 生视频 → 视频复刻」选择模型，并在平台配置中启用 Atlas Cloud、填写 API Key。旧的方舟、百炼或其他模型配置会在读取时回退为 Atlas Seedance 2.5；其他生成场景仍使用各自的模型设置。

编辑模型列表展示官方基础单价（美元/生成秒，2026-10-16 核对），并链接至所选模型的官方价格页：

| 模型 | 每秒起价 |
| --- | --- |
| [Seedance 2.5](https://www.atlascloud.ai/models/bytedance/seedance-2.5/reference-to-video) | $0.134 |
| [Seedance 2.0](https://www.atlascloud.ai/models/bytedance/seedance-2.0/reference-to-video) | $0.09 |
| [Wan 3.0](https://www.atlascloud.ai/models/alibaba/wan-3.0/reference-to-video) | $0.04 |
| [Wan 3.0 Prime](https://www.atlascloud.ai/models/alibaba/wan-3.0-prime/reference-to-video) | $0.061 |

这些是模型基础价格，清晰度和增强档位可能影响最终费用，以平台实际计费为准。设置页对这四个 Atlas 模型同样使用每秒单位，优先展示平台实时目录价格，目录不可用时使用已核对的基础价格。

新片段和切换编辑模型时默认使用 720p；调试时可单独改为 480p，以控制付费调用成本。旧草稿保留已保存的清晰度。

## 请求与素材

先在「设置 → 对象存储」配置火山 TOS 的 S3 兼容 Endpoint、Region、Bucket 和访问密钥。视频切片、原声切片、上传参考图、新上传音轨及其切片、主播配音和生成结果统一上传到这个存储桶，同时登记到素材库。素材库支持图片、视频、音频分类。旧草稿中的云端素材引用会还原为已保存的原始照片；缺少照片时要求重新添加参考图。

编辑请求使用 reference-to-video 端点，`duration: -1` 让输出跟随原视频时长，`ratio: adaptive` 保留源视频比例。Seedance 2.5 额外传入 `omni_reference_task_type: edit`；Seedance 2.0 不传这个未在其文档中声明的参数。提示词引用使用 `@Video1`、`@Image1`、`@Audio1`；旧草稿里的中文引用会自动转换。

Wan 3.0 / Prime 将视频、图片、音频合并为 `refers: [{url, type}]`，显式标注 `video` / `image` / `audio`，保留各类素材的编号顺序。音频开关使用 `audio`。每段最多 10 张图、1 条源视频、5 条音频；页面流程只传一条对齐音频。Wan 的 `duration: -1` 表示智能时长、`ratio: adaptive` 表示自适应构图，模型可能调整时长；最终拼接按源片段时长对齐。Wan 不提交 `watermark`、`draft`、`return_last_frame`、`output_format` 或 `omni_reference_task_type`，切换模型时重置草稿、末帧和输出格式。

官方接口：[Wan 3.0](https://www.atlascloud.ai/docs/en/more-models/alibaba/wan-3.0-reference-to-video/generateVideo)、[Wan 3.0 Prime](https://www.atlascloud.ai/docs/en/more-models/alibaba/wan-3.0-prime-reference-to-video/generateVideo)。

Seedance 2.5 的 Atlas 请求示例：

```json
{
  "model": "bytedance/seedance-2.5/reference-to-video",
  "prompt": "编辑视频：将 @Video1 中的人物换成 @Image1 中的人物，保留原视频的运镜、动作与节奏。",
  "reference_videos": ["https://example.com/source.mp4"],
  "reference_images": ["https://example.com/portrait.png"],
  "duration": -1,
  "ratio": "adaptive",
  "resolution": "720p",
  "omni_reference_task_type": "edit",
  "generate_audio": false,
  "watermark": false
}
```

调用 `POST https://api.atlascloud.ai/api/v1/model/generateVideo`，使用 `Authorization: Bearer <API_KEY>`；得到任务 ID 后，通过 `GET /model/prediction/{id}` 查询结果。应用在开始查询前保存付费任务，避免任务失联后丢失恢复入口。

## 分段与结果

为控制迭代费用，编辑片段保持 4–10 秒，Seedance 2.5 每段最多 30 张参考图，2.0 每段最多 9 张。长视频自动切段，只提交有修改的片段；没有修改的片段沿用源视频。参考图按页面可见的素材列表固定编号，删除或调整素材后按资源身份更新已保存的提示词引用；删除仍被引用的图片会阻止生成并提示重新选择。旧修改时间段换算为片段内时间。

每次点击只生成当前段，结果下载后等待人工确认；确认后才解锁下一段。所有段确认后手动拼接。按用户选择保留原声、静音、附加配音或保留生成音频。失败恢复保留已完成片段，首次生成前创建项目，API 调用记录带项目 ID。

接口 `/api/ai/video` 对 `scene: video_remake` 请求校验平台、模型、模式和单条源视频要求，并在服务端固定编辑参数，避免旧配置覆盖时长、比例和参考素材。

官方参考：[Seedance 2.5](https://www.atlascloud.ai/docs/zh/more-models/bytedance/seedance-2.5-reference-to-video/generateVideo)、[Seedance 2.0](https://www.atlascloud.ai/docs/zh/more-models/bytedance/seedance-2.0-reference-to-video/generateVideo)。

## 操作流程

1. **上传参考视频并分段**：从素材库选择或上传。默认单段最长 10 秒，可选 8 秒；可优先匹配 FFmpeg 检测到的转场，也可均匀切段。不足 4 秒的尾段会重新分配到相邻片段，覆盖整条视频、不丢帧。点击「确认分段并提取音频」，用同一组 `start/end` 精确切割视频和 MP3。开始生成后锁定分段规则，避免把已付费结果对应到不同时间段。
2. **添加参考素材**：上传模特、货品、背景参考图，或从素材库选择；选用旧素材时也会补齐对象存储登记。单独的「编辑指令」区域已移除，修改要求直接写在「逐段生成与确认」的当前段 Prompt 中。输入 `@` 后按图片、视频、音频分类展示可用素材，支持名称搜索、上下键选择、Enter/Tab 插入、Escape 关闭。当前视频为 `@Video1`，当前段参考音频为 `@Audio1`，图片为 `@Image1…`。
3. **准备声音**：原视频音轨自动切片。也可上传从 0 秒覆盖全片的 WAV/MP3 作为替换音轨，按相同边界切片。「按视频分段识别音频」使用设置中的 SenseVoice、Fish 或 Whisper，识别请求严格复用视频边界，保留全片绝对时间。选择主播配音时可修改台词，生成的配音同样按视频边界切片，传入 `@Audio1` 驱动口型。付费配音沿用设置中的 TTS 平台（如 MiniMax 直连），每条只尝试一次，不自动重试；口型随携带参考音频的视频请求生成，不另调独立口型模型。
4. **仅生成当前段**：检查原片、台词、参考音频、完整提示词和参数。没有修改的片段可免费沿用原片。每次操作只提交一个视频任务，不后台启动后续段，不自动重试付费生成。结果及时下载，原片和结果在页内对照预览。
5. **预览并确认**：满意后点击「满意，确认本段并继续」，才解锁下一段。不满意可改参数/指令，只重做当前段。改动先前段会要求重新确认后续结果；参数或引用变化后，旧结果不能直接确认。已完成且要求未变化的段可以重新确认，无须重新生成。
6. **手动拼接**：连续确认所有段后点击「拼接已确认片段」。FFmpeg 将每段补齐/裁切到计划时长，统一到源视频尺寸和帧率，防止模型输出短约 0.4 秒引起累计漂移。使用生成音频时，逐段保留结果音轨，无音轨的结果补静音。成片作为一个可分段播放的视频保存到素材库。

字幕指令要求将字幕直接叠加在原视频画面上，不添加黑底、黑色字幕条或独立字幕画面；去除字幕时还原对应的原视频背景。逐段自定义 Prompt 的最终请求同样附加字幕约束，请求预览与实际发送保持一致。这些画面要求由视频编辑模型执行。

这版采用 FFmpeg 本地分段，不依赖 Codex CLI。后续若接入内容理解，CLI/视觉模型只输出镜头内容和建议切点，仍由同一个分段计划驱动视频、识别和音频切割，人工确认后再生成。

## 每段可见的 Atlas 字段

| API 字段 | 编辑页行为 |
| --- | --- |
| `model` | 每段选择 Seedance 2.5 / 2.0、Wan 3.0 / Prime reference-to-video；默认沿用视频复刻模型设置 |
| `prompt` | 自动生成，可逐段编辑全文，也可恢复自动指令 |
| `reference_images` / `refers` | 展示本段实际引用顺序；Seedance 2.5 最多 30 张，2.0 最多 9 张，Wan 最多 10 张 |
| `reference_videos` | 当前段的一条原视频切片；编辑模式要求恰好一条 |
| `reference_audios` | 当前段的原声/上传音轨/主播配音切片；可关闭原声或上传音轨引用，主播口型同步始终使用配音引用 |
| `duration` | 展示固定 `-1`；Seedance 跟随参考片段时长，Wan 使用智能时长 |
| `ratio` | 展示固定 `adaptive`；保留参考片段比例 |
| `omni_reference_task_type` | 2.5 固定 `edit`，避免 auto 推断造成异步参数失败；2.0 不提交 |
| `resolution` | 展示当前模型全部档位；2.5 包含原生 480p/720p/1080p、SR/ESR 和 `1080p-esr & 60fps`、`4k-esr` |
| `generate_audio` / `audio` | 可开关，默认 true；Wan 使用 `audio`。最终音轨另选「保留原声 / 静音 / 主播配音 / 使用生成音频」 |
| `watermark` | Seedance 可开关，默认 false；Wan 不支持 |
| `return_last_frame` | 2.5 可开关，默认 false |
| `output_format` | 2.5 可选 mp4/mov，本地保存沿用对应扩展名；最终拼接导出 mp4 |
| `draft` | 2.5 可开关，覆盖分辨率生成 480p；正常计费，返回的 `draft_id` 保存到草稿 |

页面提供完整请求预览；参考素材登记完成后展示对象存储 URL。生成请求携带资源 ID，服务端根据资源记录重新签名，向模型统一传入可访问的 HTTP(S) URL。服务端只接收白名单参数，并重新固定编辑模式、时长、比例和参考媒体，避免旧设置覆盖。图片、视频、音频仍需符合 Atlas 的媒体约束（格式、尺寸、时长、大小）；本流程每次只提交一条 4–10 秒视频和最多一条同时间段参考音频。

`draft=true` 是付费低清预览，不能宣称免费试跑。Atlas 的 `draft-complete` 可在七天内完成 1080p，本页目前保存 `draft_id`，尚未实现高清补全。原生 1080p 与 SR/ESR 是不同档位，不把增强输出当作原生高分辨率；最终拼接保持源尺寸。

## 恢复与兼容

项目草稿 v3 保存资源 ID/MD5/对象地址以及分段设置、视频/音频切片、逐段参数、确认状态和付费任务恢复信息。生成前先保存当前段的运行状态；付费任务 ID 由 `/api/ai/video` 在轮询前写入任务表，收到 ID 或结果 URL 后同时写入草稿。轮询超时通过 `/api/ai/video/task` 查询原任务，下载失败重试保存原结果，不再创建任务。中途取消不能退回已提交的调用费用；不知道任务 ID 时显示任务中心恢复提示并阻止盲目重提。

旧版 v2 草稿可继续加载，按原素材顺序迁移提示词编号，本地切片在使用时补登记到对象存储和素材库。旧版 v1 草稿仍恢复源素材、修改和最终成片；旧版 15 秒分段的运行索引不直接当作新版 10 秒分段结果使用，需重新准备和确认。

## 素材去重和 URL 生命周期

迁移 `0026_reference_resources.sql` 为素材库增加 `content_md5`、`object_endpoint`、`object_url`，并创建 `reference_cloud_copies`。文件按内容计算 MD5，同一内容只登记一条素材；对象键使用 `<prefix>/md5/<MD5>.<ext>`，不同目标存储配置分别保留云端副本记录。进程内并发合并上传，应用重启后仍能复用已保存的映射。

每次使用前向对象存储发送 HEAD：对象存在则复用，404 则按同一对象键补传；鉴权或其他存储错误直接阻止生成。数据库保存稳定对象地址，不保存带签名的临时 URL 或密钥；请求时签发 24 小时访问 URL。旧草稿中的临时链接不作为后续生成依据。未配置对象存储时，页面提示完成配置，不能开始分段上传或提交付费视频任务。

`POST /api/remake/resources` 支持批量文件上传，以及按素材 ID、本地文件 URL、远程 URL 登记旧素材。远程资源先下载校验再归档，编辑请求不再使用 Atlas 临时媒体托管或 Base64 图片引用。素材详情可查看 MD5 和稳定对象地址。
