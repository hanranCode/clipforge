# Agent 成片超分真实验收（2026-10-27）

本机实际完成一次从 ClipForge Agent 工作室发起的 1080P 视频超分，验证输入上传、Temporal GPU 执行、火山 TOS 预签名 PUT、结果下载校验、Chrome 播放与下载。没有重新生成视频，也没有重复提交超分。

## 本机连接

复用 `AI_NODES_CLI` 指定的 `ai-nodes`（temporal-ai-nodes 0.1.0）、`~/.config/temporal-ai-nodes/caller.env` 中已有连接及其指向的 Caller 证书、服务端 CA 和 payload key。未重新生成证书或扩大网关权限。

仓库根目录创建本机 `.env.local`，权限 0600，已确认由 Git 忽略。它只保存连接参数、现有证书/密钥文件路径及 CLI 路径，不复制证书或密钥内容。Next.js 已实际加载，作品详情返回 `aiNodesConfigured=true`。TOS 使用用户真实 Chrome 中已配置的上海区域私有桶，不读取或输出浏览器中的 AK/SK，不将其复制到环境文件。

独立 Chromium 验证环境没有用户的 TOS 本地配置，因此真实提交流程改用已有 Chrome 配置中新建的专用验证页。通过页面原有超分按钮提交，既有配置直接随应用请求使用。

## 唯一真实任务

- 作品：`509d20b9-d8af-46d3-85f6-325cf3251d9c`（同款垃圾桶 · 新人物与浴室 · 9秒）。
- 版本：`808cc3cd-32ef-4c01-a6be-ecdf23f6726d`。
- Workflow：`media-sr-7630423e-755a-4430-a5cd-866bf7f3fbf4`。
- Run：`01a17b4f-1fc5-7d22-8332-d7ca910a4f7b`。
- Temporal 终态：`COMPLETED`。
- 执行起止：北京时间 2026-10-27 11:02:25.478–11:03:58.843，约 93.4 秒。
- Engine：`flashvsr-plus-base`；上传模式：`presigned_put`。

输入为本地已完成成片：496×864、24fps、9.000 秒、3,014,532 字节，H.264/AAC，视频与音轨从 0 开始。

输出为 1080×1920、24fps、216 帧、7,618,548 字节，H.264/AAC。视频帧时长为 9 秒；AAC 封装后的容器时长为 9.024 秒，视频与音轨均从 0 开始。结果 SHA-256：

```text
672353440cf268302484988e1ba96bde818fea786f23cae24062ffb17d5dc197
```

## 验证结果

| 链路 | 实际证据 |
| --- | --- |
| 连接 | 现有 Caller 对既有成功工作流执行 status，返回 COMPLETED；本次工作流成功提交并由现有 Worker 领取，第 1 次 Activity 执行 |
| 输入上传 | 通过真实 Chrome 页面点击一次「超分到1080P」，输入先上传 TOS，随后返回并持久化 workflow/run ID |
| 输出 PUT | 工作流结果 `upload_mode=presigned_put`，输出写入 ClipForge 为本次分配的独立 TOS object key |
| 本地归档 | ClipForge 按保存的 object key 重新签名 GET，校验字节数与 SHA-256 后保存独立超分版，状态 completed |
| 页面恢复 | 刷新作品详情页后仍显示「1080P超分版已保存」及预览/下载入口 |
| 浏览器播放 | Chrome 解码尺寸 1080×1920，readyState=4、paused=false；播放到 currentTime=9.024、ended=true、error=null；原生进度条回退后 currentTime=8.93376 |
| 分段读取 | Range bytes=0-1023 返回 HTTP 206，Content-Range bytes 0-1023/7618548，Content-Type video/mp4 |
| 实际下载 | 点击真实页面「下载超分版」，Chrome 保存到 ~/Downloads；下载文件、本地归档文件和工作流结果 SHA-256 三者一致 |
| 完整解码 | 系统 ffmpeg 对超分文件完整解码到 null，退出码 0，无解码错误 |
| 控制台 | 刷新后的验证页 error 级控制台日志为空 |
| 回归 | ai-nodes-client、超分后端及面板 3 个测试文件共 18 项测试通过 |

本地归档：`data/output/agent-studio/509d20b9-d8af-46d3-85f6-325cf3251d9c/versions/808cc3cd-32ef-4c01-a6be-ecdf23f6726d/upscaled-7630423e-755a-4430-a5cd-866bf7f3fbf4.mp4`。

浏览器下载：`~/Downloads/upscaled-7630423e-755a-4430-a5cd-866bf7f3fbf4.mp4`。

截图保存在本机忽略目录 `data/verification/super-resolution-20261027/preview.png` 与 `workspace.png`。原成片与编辑工程继续保留，Seedance 原生成费用记录未变；本次没有核对 GPU 或 TOS 账单。此证据限于这一条 9 秒视频，不代表长视频压力测试或画质基准。

## 本机工具注意事项

网关 RPC 白名单禁止 `DescribeTaskQueue`，该探测收到 403；应使用已知 workflow ID 的 status/describe 验证 Caller 连接，不扩大权限。工作流查询和真实执行均已成功。

本机 npm 内的 ffprobe 二进制不能直接执行，本次媒体验证使用系统 `/opt/homebrew/bin/ffprobe` 和 `ffmpeg`。`shasum` 因本机 C.UTF-8 locale 异常退出，改用 Python hashlib 并成功核验三个摘要；未修改系统 locale。
