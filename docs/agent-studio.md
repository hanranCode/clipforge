# Agent 工作室

ClipForge 负责作品、版本、视频费用、成片和编辑入口，本机 Agent CLI 负责参考理解与结构化方案。入口：`/agent-studio`。运行时设置：`/settings?tab=agents`。

## 使用

1. 在终端安装并登录 Codex CLI 或 Claude Code。在设置 → Agent 运行时注册，填写名称、CLI 和可选模型。检测已安装版本不代表模型鉴权通过。
2. 注册后点击「在本机启动」，等待在线心跳。也可复制一次性展示的命令到终端运行。终端命令适合排查桌面应用的 PATH 或登录环境问题。令牌存于 `~/.config/clipforge/runtimes/<id>.json`，文件权限为600。离线后也可以在运行时卡片点击启动，沿用本机连接配置。注销立即禁用令牌；守护进程收到401后退出。
3. 在工作室选择素材库的视频，填写保留和换新的要求、声音、480P/720P与运行时。当前支持4–180秒，按整数秒规划，每段4–15秒；更长素材先裁切。
4. 点击拆解会在本机用FFmpeg抽六张关键帧、SenseVoice转写音轨，再通过所选CLI的模型服务分析。这些参考内容会发送给该CLI使用的服务，CLI费用按它自己的账户结算。本步骤不请求视频生成。
5. 检查方案，可直接修改每段口播与镜头提示词并保存。检查商品裁切没有人脸；可打开「选择或调整商品参考」，选择关键帧并拖动框选或输入百分比，保存后重新确认；无法安全裁切时采用纯文字生成并说明一致性限制。确认参考策略和本版本预算后，才会调用火山引擎。
6. 成片保存为独立版本。下载、对比参考与成片，「进入编辑」可调整字幕、删词、节奏并导出编辑版本。「启动 Hypit 编辑」通过在线运行时打开该版本的本地SVML/SVRun工程，进程退出后可点击「重新启动工程」，需要另行安装Hypit CLI。原运行时注销后，可在作品页选择新运行时重新拆解，或为已完成版本启动Hypit工程。

默认视频模型固定为官方 `doubao-seedance-2-0-mini-260615`，不自动换平台。浏览器沿用设置里的火山Key，也可由本地服务的 `ARK_API_KEY` 提供。浏览器传入的Key仅保存在服务进程内存中，不进入工程、Agent CLI、事件或SQLite；服务重启后可能需要重新连接凭据再恢复。模型可用性和云端审核以实际接口响应为准。

无裁切的纯文字模式采用视频模型生成声音；有商品裁切时可提供免费Edge新配音参考。保留原声音会在最终合成时复用参考音轨，Hypit工程也引用这份最终音轨。换新声音不等于身份克隆或逐帧动作复制。

## 本地依赖与排障

需要Node20+、FFmpeg/FFprobe、已登录的Codex或Claude CLI。声音识别使用设置里下载的SenseVoice模型（约240MB），没有音轨则跳过；缺少模型会显示错误，先在设置 → 配音/语音识别下载，再重新拆解。没有外部模型或付费转写的隐式回退。

```sh
node bin/clipforge-agent.mjs --help
# 注册时复制完整启动命令；之后可以复用本机配置，不再传令牌：
node bin/clipforge-agent.mjs --runtime <registration-id>
```

本地运行时只连接loopback HTTP，必须和ClipForge在同一台电脑。默认 `pnpm dev` / `pnpm start` 和桌面服务均绑定 `127.0.0.1`。Host/Origin检查只防止浏览器跨源调用，不是网络鉴权；请勿把本地 Agent 接口通过公开网卡、容器端口或反向代理暴露给其他设备，远程部署需要另行实现访问控制。当前不是远程执行集群。CLI通过固定参数、无shell的子进程运行，Codex使用只读沙盒与结构化输出并忽略用户配置，Claude使用plan权限、Read工具及空MCP配置；模型可在注册时指定。CLI的本机登录仍沿用。参考和转写是数据，不是执行指令。视频提供商和运行时凭据会从CLI子进程环境剥离。

桌面打包会带入 `bin/` 下的守护进程代码，Electron通过自己的Node模式启动。Agent CLI与Hypit仍需安装在本机并能被应用进程PATH找到。某些从Finder启动的应用未继承终端PATH时，请使用设置中复制的终端命令；不自动安装、登录或修改CLI账户。自定义应用代码位置时，可设置 `APP_AGENT_BIN_DIR` 指向包含 `bin/clipforge-agent.mjs` 的应用根目录。

## 费用与故障恢复

视频估算基于9:16原生尺寸、24fps及无视频参考输入的每百万输出Token ¥23，含15%余量。480P的9秒预计约¥2.40。每段实际费用从火山返回的 `usage.completion_tokens` 计算；界面只合计可核对的视频费用，CLI订阅/用量单独结算。价格为当前实现采用的刊例假设，正式账单仍以火山账户为准。预算控制是否继续提交下一段，无法撤回已经被云端接受的单次费用；若某次实际用量超出预估则停止后续提交。

队列、计划快照、版本、任务ID与事件保存在独立 `data/agent-studio.sqlite.db`（桌面环境沿用APP_DATA_DIR），不变更原有项目数据库schema。一次确认只建立一个版本；相同作品最多一个活跃任务。

- 运行时每10秒心跳，任务租约60秒。过期进入「需要处理」，不会自动重发生成请求。
- 版本素材准备超过60秒仍未完成时，排队任务会进入「需要处理」，可恢复准备；运行时领取任务时也会检查，无需保持浏览器打开。
- 每段在HTTP创建前持久化`submitting`，获得ID后持久化`submitted`，后续仅查询这个ID。
- 网络中断或创建结果不明时标为`unknown`。先在火山控制台核对，再在作品页补录真实任务ID，恢复只查询已有任务。没有找到任务时不要直接猜测ID或新建同一提交。
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

CLI接口参考：[Codex非交互模式](https://developers.openai.com/codex/noninteractive/)、[Claude Code无头模式](https://code.claude.com/docs/en/headless)。
