# Agent 工作室

ClipForge 负责作品、版本、视频费用、成片和编辑入口，本机 Agent CLI 负责参考理解与结构化方案。入口：`/agent-studio`。运行时设置：`/settings?tab=agents`。

## 使用

1. 在终端安装并登录 Codex CLI、Claude Code、Hermes Agent 或 DeepSeek Harness。在设置 → Agent 运行时注册，填写名称、CLI 和可选模型。检测已安装版本不代表模型鉴权通过。
2. 注册后点击「在本机启动」，等待在线心跳。也可复制一次性展示的命令到终端运行。终端命令适合排查桌面应用的 PATH 或登录环境问题。令牌存于 `~/.config/clipforge/runtimes/<id>.json`，文件权限为600。离线后也可以在运行时卡片点击启动，沿用本机连接配置。注销立即禁用令牌；守护进程收到401后退出。
3. 在工作室选择素材库的视频，填写保留和换新的要求、声音与运行时，并选择视频供应商、模型和清晰度。当前支持4–180秒，按整数秒规划，每段4–15秒；更长素材先裁切。
4. 点击拆解会在本机用FFmpeg抽六张关键帧、SenseVoice转写音轨，再通过所选CLI的模型服务分析。这些参考内容会发送给该CLI使用的服务，CLI费用按它自己的账户结算。本步骤不请求视频生成。
5. 检查方案，可直接修改每段口播与镜头提示词并保存。检查商品裁切没有人脸；可打开「选择或调整商品参考」，选择关键帧并拖动框选或输入百分比，保存后重新确认；无法安全裁切时采用纯文字生成并说明一致性限制。确认参考策略和本版本预算后，才会调用所选视频供应商。
6. 成片保存为独立版本。下载、对比参考与成片，「进入编辑」可调整字幕、删词、节奏并导出编辑版本。「启动 Hypit 编辑」通过在线运行时打开该版本的本地SVML/SVRun工程，进程退出后可点击「重新启动工程」，需要另行安装Hypit CLI。原运行时注销后，可在作品页选择新运行时重新拆解，或为已完成版本启动Hypit工程。

新作品默认沿用「设置 → 视频模型 → 视频编辑」的平台与模型。创建弹窗和作品页右侧都可切换视频供应商、模型与清晰度；提供火山 Seedance 2.5 / 2.0 / Mini、百炼 Wan 3.0 / Prime 和 Atlas 对应参考生视频模型。Mini 支持480P/720P，其余模型提供480P/720P/1080P。Atlas参考模型需要至少一张参考图；无图时会在付费提交前提示。页面的「沿用视频编辑设置」可重新同步全局选择；作品已有独立配置时不会被全局设置覆盖，未配置全局可用模型的旧入口保留 Mini 兼容默认。

待确认方案可直接应用新的视频配置，无须重新拆解；修改会重算预算并清除确认状态。正在生成或恢复的版本锁定配置。每个生成版本冻结 provider/model/resolution/Endpoint，历史版本显示真实配置；修改下一版参数、全局设置或切换历史版本不会改写已提交任务。切换保存前会给旧版 Mini 版本补齐历史配置，避免旧片被误标成百炼。

浏览器使用所选供应商在设置中的 Key/Endpoint；百炼 Wan 3.0 需要同地域业务空间 Endpoint。服务环境变量可提供 `ARK_API_KEY`、`DASHSCOPE_API_KEY` 或 `ATLAS_API_KEY`，不跨平台借用密钥。百炼和 Atlas 复用现有适配器，保留一次提交、保存任务ID、后续只查询同一任务的回执流程。百炼的参考音频先上传对象存储，使用公网可访问的签名URL（不发送音频Base64）；可沿用浏览器对象存储设置，或使用服务本地对象存储配置。Atlas使用该平台素材上传接口；图片顺序和职责提示保持一致。浏览器传入的Key仅保存在服务进程内存中，不进入工程、Agent CLI、事件或SQLite；服务重启后可能需要重新连接凭据再恢复。模型可用性和云端审核以实际接口响应为准。

无裁切的纯文字模式采用视频模型生成声音；有商品裁切时可提供免费Edge新配音参考。保留原声音会在最终合成时复用参考音轨，Hypit工程也引用这份最终音轨。换新声音不等于身份克隆或逐帧动作复制。

商品裁切保留确认的区域与原比例；缩放后任一边不足 300px 时居中补白，避免窄商品裁成 `240×600` 后被火山接口拒绝。提交前对商品、主播、场地参考图统一检查双边尺寸，对不足的图片生成补白副本，不扩大原视频裁切区域，也不改写已确认的版本快照。已准备的旧版本在恢复时同样处理；明确返回 400 且没有任务 ID 的分段可以通过「恢复此版本」继续，无需重新拆解。已提交或结果未知的任务仍遵循原有回执规则。

## 本地依赖与排障

需要Node20+、FFmpeg/FFprobe、已登录的Codex、Claude、Hermes或DeepSeek Harness CLI。声音识别使用设置里下载的SenseVoice模型（约240MB），没有音轨则跳过；缺少模型会显示错误，先在设置 → 配音/语音识别下载，再重新拆解。没有外部模型或付费转写的隐式回退。

```sh
node bin/clipforge-agent.mjs --help
# 注册时复制完整启动命令；之后可以复用本机配置，不再传令牌：
node bin/clipforge-agent.mjs --runtime <registration-id>
```

本地运行时只连接loopback HTTP，必须和ClipForge在同一台电脑。默认 `pnpm dev` / `pnpm start` 和桌面服务均绑定 `127.0.0.1`。Host/Origin检查只防止浏览器跨源调用，不是网络鉴权；请勿把本地 Agent 接口通过公开网卡、容器端口或反向代理暴露给其他设备，远程部署需要另行实现访问控制。当前不是远程执行集群。CLI通过固定参数、无shell的子进程运行，Codex使用只读沙盒与结构化输出并忽略用户配置，Claude使用plan权限、Read工具及空MCP配置；模型可在注册时指定。Hermes使用`hermes chat --query-file - --format stream-json`及vision工具集，忽略规则注入；Harness使用`dsh --profile headless --json -`与read-only权限、never审批策略，读取关键帧后返回JSON。只接受成功退出且终态完成的输出，之后统一校验方案。Hermes与Harness没有原生JSON Schema输出约束，schema随提示词传入。Harness的可选模型支持`provider/model`，仅填模型名时使用`deepseek-official`；其headless模式需配置可用的模型路由和环境凭据（不默认读取GUI登录）。CLI的本机模型配置沿用。参考和转写是数据，不是执行指令。视频提供商和运行时凭据会从CLI子进程环境剥离。

桌面打包会带入 `bin/` 下的守护进程代码，Electron通过自己的Node模式启动。Agent CLI与Hypit仍需安装在本机并能被应用进程PATH找到。某些从Finder启动的应用未继承终端PATH时，请使用设置中复制的终端命令；不自动安装、登录或修改CLI账户。自定义应用代码位置时，可设置 `APP_AGENT_BIN_DIR` 指向包含 `bin/clipforge-agent.mjs` 的应用根目录。

## 费用与故障恢复

视频预算随供应商、模型和清晰度变化，包含15%余量（各平台估算方式见文末）。Mini兼容估算仍基于9:16原生尺寸、24fps、无视频参考输入及每百万输出Token ¥23；480P的9秒预留约¥2.40。火山返回的 `usage.completion_tokens` 可用于Token费用折算；百炼和Atlas按单价预估，界面标记“≈”，均不代表账户账单。CLI订阅/用量单独结算。预算控制是否继续提交下一段，无法撤回已经被云端接受的单次费用；若某次用量超出预估则停止后续提交。

队列、计划快照、版本、任务ID与事件保存在独立 `data/agent-studio.sqlite.db`（桌面环境沿用APP_DATA_DIR），不变更原有项目数据库schema。一次确认只建立一个版本；相同作品最多一个活跃任务。

- 运行时每10秒心跳，任务租约60秒。过期进入「需要处理」，不会自动重发生成请求。
- 版本素材准备超过60秒仍未完成时，排队任务会进入「需要处理」，可恢复准备；运行时领取任务时也会检查，无需保持浏览器打开。
- 每段在HTTP创建前持久化`submitting`，获得ID后持久化`submitted`，后续仅查询这个ID。
- 网络中断或创建结果不明时标为`unknown`。先在原供应商控制台核对，再在作品页补录真实任务ID，恢复只查询已有任务。没有找到任务时不要直接猜测ID或新建同一提交。
- 已知任务ID的下载、拼接、字幕识别失败可以恢复。已完成分段不会重复生成。
- 「停止」阻止后续提交，已提交云端任务可能继续执行和计费，ID会保留。
- 成片完成后即使自动转写失败，也保留视频和编辑入口，可以在编辑器中重新识别字幕。
- 导出工程的Hypit编辑器由运行时启动，日志在该版本目录`studio.log`。关闭运行时不会主动杀死用户已打开的工程编辑器。

成片和工程：`data/output/agent-studio/<work>/versions/<version>/`，包括`final.mp4`、`poster.jpg`、各段、计划、账单回执及Hypit的`finished.svml`、`finished.svrun`、`film.svs`和仅含本地媒体端点的运行配置。原生编辑器使用一份不可变的成片副本`data/uploads/<project>/imported/<version>.mp4`，生成版本之间不会覆盖。

已有Hypit作品可在`videos/productions/<slug>/clipforge-production.json`提供显式清单，工作室会提示导入。仅接受这个项目目录内的真实成片与海报，不执行清单里的内容。清单包含title、sourceAssetId、duration、resolution、file、poster、taskId、tokens、brief和结构化plan；当前清单导入支持单个完整分段。导入按slug去重、保留真实用量，不触发视频生成。已导入作品的计划、视频与账单仍可查看。

## 验证

```sh
node node_modules/vitest/vitest.mjs run src/lib/__tests__/agent-studio-*.test.*
node node_modules/typescript/bin/tsc --noEmit --incremental false
CLIPFORGE_DIST_DIR=.next-agent-build node node_modules/next/dist/bin/next build
```

生成网络在测试中全部模拟，不消耗视频额度。覆盖令牌哈希/注销、队列互斥、预算和方案快照、租约过期、未知提交禁止重发、取消中仍保存回执、CLI参数与密钥隔离。真实模型拆解应先获得对参考素材发送到该CLI服务的授权；真实视频生成需在界面单独确认方案和预算。

CLI接口参考：[Hermes CLI](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md)、[DeepSeek Harness headless](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)、[Codex非交互模式](https://developers.openai.com/codex/noninteractive/)、[Claude Code无头模式](https://code.claude.com/docs/en/headless)。

## 成片超分到 1080P

已完成版本（包括导入归档的作品）的结果页提供「视频超分 · 1080P」。原成片、编辑工程与视频生成费用记录保留，超分版单独保存，可预览和下载。输入限制为非空且不超过 **200,000,000 字节**。服务当前输出横屏 1920×1080 或竖屏 1080×1920，按比例补边；默认使用 Base，不提供 4K。Turbo 仅在运营者显式启用已部署预设后可选，见下文参数说明。

### 服务端准备

按 [AI Nodes Agent 接入文档](https://github.com/hanranCode/temporal-ai-nodes/blob/main/docs/public/agent-integration.md) 安装 `ai-nodes` CLI，在启动 ClipForge 的进程环境配置：

```text
# 可选：CLI 的绝对可执行文件路径（不是 shell 命令）
AI_NODES_CLI=/absolute/path/to/ai-nodes
TEMPORAL_ADDRESS=<operator-provided-address>
TEMPORAL_NAMESPACE=ai-media
TEMPORAL_TASK_QUEUE=media-sr-h800-v1
TEMPORAL_SERVER_CA=/private/path/server-ca.pem
TEMPORAL_CLIENT_CERT=/private/path/client.pem
TEMPORAL_CLIENT_KEY=/private/path/client-key.pem
AI_NODES_PAYLOAD_KEY_FILE=/private/path/payload.key
```

连接信息、独立客户端证书及加密密钥由运营者私下提供。重启 ClipForge 使其继承环境；桌面端也需要在其服务进程中提供该环境和外部 CLI。前端只获知是否已配置，不读取证书内容。调用官方 CLI 以复用其 mTLS、加密 DataConverter 与敏感失败编码，避免不同 SDK 编解码不兼容。请求临时目录权限 0700、文件 0600，调用结束清理；不会把签名 URL 放入命令参数、事件或作品数据库。

超分的火山 TOS 配置由本地服务直接读取，浏览器请求不携带对象存储 AK/SK。此入口要求火山 TOS 的公网 HTTPS/443 S3 Endpoint、私有桶，以及输入上传和输出读写权限。可选择以下方式之一：

- 在服务进程提供 `TOS_ENDPOINT`、`TOS_REGION`、`TOS_BUCKET`、`TOS_ACCESS_KEY_ID`、`TOS_SECRET_ACCESS_KEY`，可选 `TOS_PREFIX` 和 `TOS_PATH_STYLE=true`。
- 将配置写入数据目录的 `private/object-storage.json`，或用 `CLIPFORGE_OBJECT_STORAGE_FILE` 指定其它绝对路径。文件字段为 `endpoint`、`region`、`bucket`、`accessKeyId`、`secretAccessKey`，可选 `prefix`、`pathStyle`。Unix 文件权限必须为 0600 等仅当前用户可读写的权限，目录建议 0700；文件位于被 Git 忽略的数据目录内。

迁移已有浏览器配置时，「设置 → 对象存储 → 导出本地服务配置」仅通过浏览器 Blob 下载 JSON，不向 HTTP 接口发送凭据。把导出文件放到页面显示的本地配置路径并设好权限，然后点「刷新本地状态」。`GET /api/storage/local` 仅返回配置状态、路径和目标桶信息；「测试连接」向 `/api/storage/test` 发送空对象，由服务读取配置并检查上传及签名读取。其它旧创作流程仍沿用浏览器配置，不属于本次超分链路改造。

### 任务与结果

1. 点击超分：本地服务将完成视频上传到 TOS，以 24 小时签名 GET URL 作为 `input_url`；给每个任务分配独立 object key，通过 `output.put_url` 提供签名 PUT 和 `headers.Content-Type=video/mp4`，同时通过 `output.read_url` 提供同一对象单独签名的 GET 地址，不发送存储配置。输出 PUT/GET 签名有效期均为 48 小时，Worker 只按 URL 读取输入、写入输出；其 `download_url` 按契约回传调用方的 `read_url`。超分 HTTP 请求拒绝额外的 `objectStorage` 等字段。
2. 在外部操作前持久化独立 request ID / workflow ID；确认提交后记录 run ID。重复点击和提交响应未知时只查询原工作流，不自动重新提交。页面打开时每 10 秒查询；离开页面不影响远端推理，重新打开可继续查询。
3. `waiting_for_output_url` 显示「更新上传地址」，使用同一 object key 重新签发 PUT/GET 两种链接并通过 `set-output` 发送信号，复用节点保留的产物。需要在节点规定的 24 小时内处理。请保持原任务的 Endpoint、区域、Bucket 与寻址方式，允许轮换 AK/SK。
4. 节点完成后，只保存输出 object key、目标存储位置、字节数、SHA-256 和宽高；对浏览器返回稳定地址 `/api/agent-studio/resources/<requestId>`，不会为了完成状态先下载一遍输出。首次访问该地址时，本地服务重新签发 15 分钟 GET URL，流式下载并校验大小与 SHA-256 后原子写入 `cache/agent-media/<sha256>.mp4`。播放和下载复用缓存，支持 Range/206、ETag/304 和 `?download=1`。缓存命中发生在读取配置和签名前，不访问 TOS；缓存跨重启有效，文件变化会重新校验，下载失败清理临时文件并允许再次访问原资源，不重新推理。缓存没有自动过期策略，清理缓存后下次访问会重新下载。
5. 取消为异步请求，继续查询直到 Temporal 确认终态。明确失败或取消后可手动重新超分，将建立新的独立任务；未知提交不会开放重提入口。进程若在输入上传阶段退出且尚未保存提交标记，后续操作会将其标为上传中断，可手动重试；已有提交标记但未获回执时仍保持未知，需要运营者按保存的 workflow ID 核对，应用不会假定未提交而重发。

Temporal 证书和加密密钥仅通过服务进程环境继承；对象存储 AK/SK 仅从主机私密文件或环境变量读取，不随任务持久化。SigV4 签名 URL 的 `X-Amz-Credential` 按协议包含 AK 标识，但不包含 SK 或可复用的完整凭据；这是限对象、方法和有效期的授权。签名 URL 也不写入作品记录或调用日志。已核对上游 [storage.py](https://github.com/hanranCode/temporal-ai-nodes/blob/main/src/ai_nodes/core/storage.py) 的 `publish()`：支持直接向 `output.put_url` 发起 PUT，并将可选 `read_url` 原样作为 `download_url` 返回。当前传入同一对象的加签 GET 地址，应用取回文件时仍重新签名并校验，不信任任意回传下载地址。

超分入口不把 GPU/TOS 用量混入 Seedance 视频生成账单；真实计算与存储费用由各服务账户结算。是否配置不代表网络、证书、CLI 安装或推理引擎已经验收；首次操作失败会显示受控错误，服务端应核对配置。媒体兼容性及拒绝规则见 [能力参考](https://github.com/hanranCode/temporal-ai-nodes/blob/main/docs/public/media-super-resolution.md)。

早期单次真实超分的连接、播放与下载记录见 [Agent 成片超分验收](agent-studio-super-resolution-verification.md)。该记录保留当时的浏览器存储配置传递和本地归档方式；当前入口使用上文的服务端配置与稳定资源缓存。

## 素材、项目与调用记录关联

Agent 工作室与「我的项目」使用同一项目关联。包括待确认方案在内的作品会显示 Agent 标识，项目卡片、工作台继续入口、已完成作品卡片均回到 Agent 详情；从素材详情进入时携带具体版本参数 `?version=…`。

成片、已完成分段、封面、已确认商品参考图和每次超分输出，会以稳定 ID 关联到素材库。普通产物归档复制到项目的 `uploads/<project>/agent-library/`；超分产物登记稳定资源地址与节点提供的宽高，访问时复用上述缓存，也能作为新作品参考素材。旧版已下载的超分文件直接按 SHA-256 迁入缓存并更新素材地址，无需再读 TOS。封面与商品裁切标注为本地 video-frame/product-crop，不能冒充一次 AI 生图调用。每条超分素材记录保留原成片的 parentAssetId，素材详情可直接查看原视频。

发布/下载完成时同步归档；素材库、项目与调用记录读接口也会按已有落盘产物和任务回执补齐历史数据，不发起生成。已归档条目标记保存在作品版本中，同步重试不复制记录；用户从素材库移除条目后不会因读取作品而自动重新添加。

Agent 视频提交使用独立调用 ID，提交前记录，回执确认、失败和完成后更新。重试是新调用，查询仍更新原调用。历史导入的真实 task ID/Token/CNY 用量标记为 imported_receipt；不伪造当时的 HTTP 响应或调用耗时，不换算并不存在的 USD 账单。超分按 workflow/request ID 一次一条，所有查询与上传地址刷新沿用该记录。签名 URL、TOS AK/SK、证书及 payload key 不进入这些记录。

## 超分参数与再次生成

超分入口放在对应生成视频的播放器内，呈现「原成片 → SR1、SR2…」关系。点击预览在同一播放器切换，原片始终保留；旧的单条 superResolution 数据兼容显示为首条历史。

点击「超分到1080P」或「再次超分」先展开参数表单，再明确提交。当前能力为 `media.super_resolution.v1`，目标 1080P。Base 可用；Turbo 虽在上游 Schema 中存在，只有运营者安装并验证权重后显式设置 `AI_NODES_VIDEO_PRESETS=base,turbo` 才可选，默认显示尚未部署。Seed 选填，留空为 1，服务端严格校验为 0–2147483647 的整数。未知能力、未知字段、不支持的目标和未部署 preset 在上传输入前拒绝。

再次超分始终使用所选版本的原成片，生成独立 request/workflow ID 和对象 key，保存该次参数及所有旧输出。只允许一个版本同时执行一次超分；正在处理或提交未知时，保留查询、取消及过期上传地址刷新入口，不通过「再次超分」绕过未知任务核对。

详情页由请求相关的服务端页面承载 Suspense 边界，客户端详情组件处理版本查询和交互，以保持带版本参数的首屏与浏览器水合结构一致。

### 2026-10-27 关联与交互验收

对既有真实作品 `509d20b9-d8af-46d3-85f6-325cf3251d9c` 的 V1 补齐了原成片、分段、封面和既有 1080P 超分结果共 4 条素材；API 调用记录按真实回执补齐视频生成和超分各 1 条，未新增模型或 GPU 请求。项目列表同时展示已完成作品和待确认方案，并通过真实 Chrome 点击验证详情跳转。

浏览器验证了超分素材 → 原成片素材、素材 → 指定 Agent 版本、API 记录 → Agent 详情；验证了再次超分表单、可编辑/留空 Seed、未部署 Turbo 禁用和同播放器切换到 1080×1920 既有结果。多次超分、独立参数、历史保留及未知提交去重由模拟传输的回归测试验证，不计为新的真实 GPU 验收。截图位于本机 `data/verification/agent-catalog-20261027/`。

全量 `src/lib/__tests__` 回归 1709 通过、1 跳过，类型检查与修改文件 lint 通过。全量中本机 HTTP 桩需主机监听权限；沙箱内两组测试曾因 listen EPERM 超时，允许监听后同套测试通过。历史回填、时间排序和素材移除不复活另有针对性回归。刷新详情页的水合错误已在真实浏览器复现并修复；实际 HTML 包含服务端 Suspense 边界，重载后的新增 error 日志为空。

### 2026-10-27 本地签名与资源缓存验收

本机已有 TOS 配置已迁入数据目录的私密配置文件（目录 0700、文件 0600，Git 忽略）；导出临时文件已清理。`/api/storage/local` 返回已配置，向 `/api/storage/test` 发送空对象完成真实微小文件上传与签名读取，返回 200。未通过 HTTP 请求上传存储配置。

复用原真实超分任务 `7630423e-755a-4430-a5cd-866bf7f3fbf4` 的既有产物，验证稳定资源地址完整下载为 7,618,548 字节，SHA-256 为 `672353440cf268302484988e1ba96bde818fea786f23cae24062ffb17d5dc197`；Range `bytes=0-1023` 返回 206 和正确长度，ETag 条件读取返回 304。Chrome 素材卡片显示原视频 496×864 与超分视频 1080×1920，详情播放器通过稳定地址解码 1080×1920、9.024 秒并播放至结尾，新增 console error 为空。

另用隔离的空缓存目录调用实际缓存模块，首次访问既有 TOS 对象产生一次真实签名 GET，并校验 SHA-256；随后禁用网络仍成功读取同一缓存。验证只下载既有产物，没有新增超分/GPU 任务。脱敏结果与截图保存在本机 `data/verification/agent-resource-cache-20261027/`；临时联网 smoke 测试已移除，常规测试不依赖真实凭据或云对象。

本轮全量回归 1724 通过、1 跳过。之后补充「本地渲染文件已清理仍可登记云资源」边界修正，相关 4 个文件共 22 项回归通过。覆盖 HTTP 凭据字段拒绝、无 `read_url` 的 PUT 契约、完成时不下载、并发缓存合并、跨模块重载复用、缓存损坏/大小/哈希拒绝、临时文件清理和本地分辨率元数据缓存。类型检查及修改文件 lint 通过。


## 商品、虚拟主播与场地参考

升级后需重启已在线的本机 Agent 运行时，以加载 `clipforge-agent/2` 规划协议；旧守护进程不会自动重载已导入的 CLI 模块。有参考素材的任务会拒绝旧运行时并提示重启，避免静默忽略图片。

新建复刻时，在选择原视频后、开始拆解前，可以从商品库选择商品图及资料、从主播库选择人像、从素材库选择场地图片。每次最多 12 份，每份选择一张 JPG / PNG / WebP（不超过 20MB）；同一商品可选不同视角。每类第一份为全片默认。未选择商品时仍可使用原片商品裁切；未选择主播或场地时沿用文字设计。此改造只涉及 `/agent-studio`，旧 `/project/remake` 流程独立。

商品、主播库沿用浏览器存储，选择时把名称、描述、商品规格/价格/人群或人物外观的限定字段提交服务端；场地素材按素材 ID 从服务端库读取，不信任浏览器提供的场地路径和资料。服务端只读取应用上传目录、输出目录及随应用附带的示例图片，校验真实路径（含符号链接）、体积、格式与可解码宽高，再复制到 `uploads/agent-references/<work>/selected/`。拒绝远程 URL、data URI、任意文件路径及越界路径；远程图片需要先导入本地素材库。素材描述与图片内文字都是资料，不是 Agent 执行指令。

Agent 拆解同时读取原片关键帧和所选素材图片，并获知每张素材的商品 / 主播 / 场地职责。原片提供节奏、运镜及演示结构，目标商品资料约束新口播和动作，不能把原商品的价格或功效移植给新商品。已选择商品库商品时不再使用原片商品裁切。人物图约束外观，声音仍独立选择。选择人像不代表视频平台允许该输入；虚拟人像也可能审核失败，系统不自动退回纯文字或切换平台。

方案审阅中，每段的 `references` 支持按 `product` / `presenter` / `scene` 分配：省略某个角色表示继承该类第一份素材，`null` 表示本段不使用该类参考，字符串为已选素材 ID。CLI JSON Schema 同时允许 `"inherit"`，解析时转为省略字段。服务端拒绝不存在、角色不符或格式错误的引用。商品特写可以不使用主播参考。手动修改分配后应检查口播与镜头描述，保存方案并重新确认。调整整个素材池需要重新规划，旧方案不能直接批准。

确认生成时，版本同时冻结计划、素材资料和文件校验值；准备阶段再复制独立图片到 `uploads/agent-references/<work>/versions/<version>/`，文件按 SHA-256 命名，以完整临时文件的原子链接写入，不覆盖旧文件。`output/agent-studio/<work>/versions/<version>/references.json` 保存素材快照与分段分配，`production.json` 也记录该快照。准备完成后任务才可领取；失败保留版本，可恢复准备。历史版本页面展示自己的素材快照与方案，并可下载 JSON。后续修改、删除商品、主播或素材库原记录不影响已捕获素材和版本文件；这些独立快照暂不自动清理。

每段视频请求只发送该段分配的图片，并通过 `@图片N` 标明商品外观、主播外观和场地布局的不同职责，最多三类图各一张；未选商品库商品时，沿用原片裁切作为商品参考。所选快照缺失或 SHA-256/大小/格式不符时，在创建视频任务前停止，不静默使用其它素材。原有云端任务 ID、预算、未知提交核对和恢复逻辑保持不变。

本功能没有自动新增付费关键帧预演。回归使用模拟 CLI / 视频平台、真实临时文件和 SQLite，不能替代具体账号的人像准入或真实多参考生成质量验收。

## 视频配置与费用验证（2026-10-27）

工作室调用日志、素材目录和 production.json 从版本快照记录实际供应商/模型。预算根据模型、清晰度、片段时长重算并预留15%；火山按响应Token与对应价格表折算，百炼和Atlas按单价估算，带“≈”并在回执中标记 costEstimated。百炼使用官方不同地域原价的保守上界，不计促销优惠；Atlas采用8元/美元的预算换算及清晰度预留，不代表实时汇率或账户账单。预算只控制后续提交，不限制已接受任务的云端收费。价格参考：[百炼模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)。

已用真实React页面交互与模拟HTTP验证默认百炼、平台/模型/清晰度切换、Key/Endpoint路由、版本冻结、任务恢复及日志标识。未触发真实付费生成，也未自动恢复用户已有任务。
