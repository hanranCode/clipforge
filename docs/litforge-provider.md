# LitForge 原子能力 Provider

2026-10-28。LitForge 是 ClipForge 的临时自定义 Provider，执行端复用 `temporal-ai-nodes` 的官方 Caller CLI。能力目录、请求转换和传输分开维护；不会将 Temporal 接口伪装成 OpenAI HTTP API。

## 能力与入口

| 应用 | 模型 ID | AI Nodes 能力 | Workflow / 队列 |
| --- | --- | --- | --- |
| Agent 工作室参考视频生成 | `litforge/wan-vace-reference-v1` | `media.video_edit.v1`，`control_reference` + `canny` | `MediaVideoEditWorkflowV1` / `media-wan-vace-h800-v1` |
| 视频复刻人物替换 | `litforge/wan-animate-replace-v1` | `media.character_animation.v1`，`replace` | `MediaCharacterAnimationWorkflowV1` / `media-wan-animate-h800-v1` |
| 视频超分 | `litforge/media-sr-v1` | `media.super_resolution.v1` | `MediaSuperResolutionWorkflowV1` / `media-sr-h800-v1` |

在设置 → 平台 Key 中启用 **LitForge · 自定义服务**。无需向浏览器输入 Caller 证书或 payload key。视频模型设置会出现三项能力；视频编辑用途只接受人物替换模型。Agent 的视频生成设置可直接选择 LitForge VACE；“参考生视频”用途设置为该模型后，新建 Agent 作品可沿用它。

设置卡片显示本机 Caller/对象存储配置和新旧任务列表。支持查询、取消，以及 Worker 等待回传地址时刷新 PUT/GET 地址。既有 Agent 和视频复刻超分任务通过原生命周期适配器查询，保留原 Workflow ID、归档资源和业务归属；历史日志的 `ai-nodes` 标识保留。

## 主机配置

服务端沿用 `TEMPORAL_ADDRESS`、`TEMPORAL_NAMESPACE`、`TEMPORAL_TLS_SERVER_NAME`、`TEMPORAL_SERVER_CA`、`TEMPORAL_CLIENT_CERT`、`TEMPORAL_CLIENT_KEY`、`AI_NODES_PAYLOAD_KEY_FILE` 和 `AI_NODES_CLI`。CLI 必须包含 `media-sr`、`wan-animate`、`wan-vace` 三个 capability。

对象存储来自已有服务端私密文件或环境变量，见 [Agent 工作室的服务端准备](agent-studio.md#服务端准备)。浏览器设置卡不会返回密钥、私密文件路径、签名 URL 或推理输入。

每次提交显式传入 `--capability`。队列覆盖分别为：

- `LITFORGE_MEDIA_SR_QUEUE`
- `LITFORGE_WAN_ANIMATE_QUEUE`
- `LITFORGE_WAN_VACE_QUEUE`

未设置时使用能力目录的队列。为兼容旧部署，SR 仍接受原 `TEMPORAL_TASK_QUEUE`；Wan 两项不会继承它，避免旧 SR 环境配置将 Wan 请求投到错误 Worker。

参考材料：[上游 Agent 接入规范](https://github.com/hanranCode/temporal-ai-nodes/blob/main/docs/public/agent-integration.md)、[能力清单](https://github.com/hanranCode/temporal-ai-nodes/blob/main/docs/public/capabilities.json)。

## 生成限制

VACE 使用一条原片控制视频和1–2张已确认参考图。工作室规划单段1–5整数秒，最多48段；生成16fps、4n+1帧，按原片片段提取 Canny 条件。当前 UI 开放480P画布，竖屏480×832。生成后在本地裁整段时长、转24fps、配入已准备的口播音轨，再沿用原合成与归档流程。人物、商品、场景不能在同一段同时传三张图，应调整分段素材分配。切换模型后，旧的超长分段方案必须重新规划；不会悄悄换回其他模型。

VACE 不生成声音，也不保证口型同步；Canny 会同时约束原片背景和服饰，严格人物/场景保真需实际素材验收。当前不开放 masked_edit 或自动 mask 定位。

人物替换需要一条单人视频和一张人物参考图，30fps、最多301帧、单段不超过10秒。帧数向下选择合法4n+1档位，防止请求超过源视频可用长度。当前 UI 限480P，不接受独立参考音频、任意 LoRA、商品或背景替换。可在 ClipForge 本地配音；模型本身的源音轨复制仅在显式启用且源视频有音轨时可用。

通用宽高限制为16倍数、各256–1280、面积不超过1280×720。输入仅 HTTPS/443；真实网络地址、素材大小、人物数量和 Worker 资源限制继续由上游校验。参数合法不等于对应配置已通过 GPU 验收。

自托管 GPU 没有核实单价，费用保持未知。工作室显示“GPU费用未知”，不显示为免费，预算控件也不用于声称可以限制自托管 GPU 实际费用。

## 任务与结果契约

输入检查和上传在工作室进入 submitting 前完成。新任务在网络提交前持久化随机 request ID、可预测的 Workflow ID、模型、对象键和存储身份；不保存提示词、参考 URL、签名输出地址或私钥。失去提交回执时保留 unknown 与原任务身份，后续只查询，不能自动重提。

完成结果必须匹配 request ID、视频类型和 PUT 回传模式；Wan 结果还核对 FPS 和帧数。共享媒体缓存按服务端重新签名的对象键下载，验证字节数与 SHA256，再原子归档到稳定的 `/api/output/litforge/<workflow-id>.mp4`。不把 Worker 返回的任意下载 URL 当作可信本地资源。

`POST /api/ai/video` 与 `/api/ai/video/task` 复用 Provider 工厂；LitForge 分支额外要求本机 Host 和同源 mutation，避免网页通过无 Key 的简单跨站请求触发主机 GPU。`GET /api/litforge` 返回配置状态、能力和脱敏任务摘要；`POST /api/litforge` 只接受已有任务的 status/cancel/refresh，不提供任意命令、路径或新任务提交能力。

## 扩展原子能力

1. 在 `src/lib/litforge/catalog.ts` 声明版本化能力 ID、CLI capability、模型 ID、Workflow、独立队列和限制。
2. 在服务端实现明确的输入映射与校验；不要靠任意 extra 字段绕过契约。
3. 接入现有耐久任务身份、结果校验、缓存、取消和回传刷新机制。
4. 只将适合某应用的模型加入该应用白名单，并补协议、失败恢复和 UI 测试。
5. 将本地契约测试、网络只读查询、真实 GPU 执行和画质验收分别记录。

## 本轮验证状态

- 本地协议测试覆盖三项模型/Workflow映射、队列隔离、未知提交恢复、结果身份/元数据、上传地址刷新、跨站拒绝、模型选择及规划约束。
- 浏览器实测：LitForge 注册和配置检查、旧超分任务列表、视频编辑切换到人物替换、Agent 新建窗口切换到 VACE/480P。未点击规划或生成按钮；原视频编辑默认模型已恢复。
- 只读查询三个既有执行：SR `media-sr-7630423e-755a-4430-a5cd-866bf7f3fbf4`；Animate `wan-animate-replace-20261027T154326Z-1abf`；VACE `wan-vace-vace-canny-20261027T154326Z-1abf`。三项均 COMPLETED，结果 Codec、尺寸、SHA256及 Wan FPS/帧数可读取。这是历史执行连接验证，不是新适配器的完整新任务验收。
- 用户明确授权后，三项新任务真实 GPU 验收均完成，每项只提交一次；原任务 HTTP 恢复查询、SHA/媒体参数、完整解码和 Chrome 末尾播放均通过。详见 [三服务 GPU 验收记录](litforge-verification-20261028.md)。opt-in `litforge-live.test.ts` 在常规测试中仍默认跳过，重跑时读取原 checkpoint，不重复提交已存在任务。

本机证据在忽略目录 `data/verification/litforge-20261028/`；其中连接报告不含签名 URL 或凭据。三项新任务已联调出片；这不等于所有配置、素材和画质标准都已验收，覆盖边界见验收记录。
