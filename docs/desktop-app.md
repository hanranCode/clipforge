# 亮色界面与桌面安装包

## 开发计划

- [x] 检查现有主题、Electron、原生依赖与发布流程。
- [x] 全站固定亮色；系统暗色模式下，网页和桌面窗口仍为亮色。
- [x] 完善原生打包：Windows x64、macOS arm64（Apple Silicon）、macOS x64（Intel）。
- [ ] 验证独立运行：不依赖用户安装 Node，内置 SQLite、FFmpeg、ffprobe、本地 SenseVoice 运行库。
- [ ] 在三个原生系统构建安装包，验证安装后的应用启动、数据库、媒体工具和亮色页面。
- [ ] 本地回归、生产构建、界面检查与代码审查通过后提交 PR。

## 验收范围

网页、导航、表单、弹窗和 Electron 原生界面固定亮色。视频画布、图片上的遮罩等媒体内容仍按素材本身显示。

支持的安装包为 Windows x64 `.exe`（NSIS）和 macOS arm64/x64 `.dmg`。每个安装包必须在相同系统和架构的 runner 上构建，原生依赖不能跨架构混用。

开发与验证不调用付费 AI 服务。自动构建不发布正式 Release；未配置签名证书的产物是未签名测试安装包。

## 本地构建

安装 Node 22 和项目指定版本的 pnpm 后，执行 `pnpm install --frozen-lockfile`。不要设置 `ELECTRON_SKIP_BINARY_DOWNLOAD`；打包需要 Electron、FFmpeg 和 ffprobe 的实际二进制。

```sh
pnpm pack:dir                  # 当前系统、当前架构的未压缩应用
pnpm dist:mac --arm64          # 在 Apple Silicon Mac 构建 DMG 和 ZIP
pnpm dist:mac --x64            # 在 Intel Mac 构建 DMG 和 ZIP
pnpm dist:win --x64            # 在 Windows x64 构建 NSIS EXE
pnpm desktop:smoke             # 本机验证未压缩应用，不运行安装器
pnpm desktop:smoke --installer # macOS：验证 DMG 中的真实应用
```

构建输出位于 `release/`，Next 桌面服务位于独立的 `.next-desktop/`，不会清理网页开发服务器的 `.next/`。直接执行 `pnpm bundle:standalone` 也使用 `.next-desktop/`；如有自定义目录，构建和补齐资源时须使用相同的 `CLIPFORGE_DIST_DIR`。

每次构建仅支持当前系统和架构，跨平台或跨架构参数会在构建前报错。SQLite 从官方发行资产替换为当前 Electron ABI；开发用的 Node ABI 副本保留。本地 SenseVoice 的运行库随包分发，识别模型仍在首次使用时按现有流程下载。

Windows NSIS 安装器会复用正式安装身份，即使指定临时安装目录也可能替换已有安装。因此 Windows 的 `--installer` 验收仅用于一次性 CI/虚拟机，必须显式设置 `CLIPFORGE_DISPOSABLE_INSTALL=1`；普通本机运行会直接拒绝，不应设置该变量。原生 CI 使用全新 runner 执行这项检查。

## CI 与安装包下载

`Desktop Packages` 工作流在 `codex/**` 分支推送、相关 PR 和手动触发时运行，也被 tag 发布流程复用。三个原生 runner 分别构建 Windows x64、macOS arm64 和 macOS x64。

在 GitHub 本仓库 **Actions → Desktop Packages → 成功的运行 → Artifacts** 下载对应的 `clipforge-desktop-win-x64`、`clipforge-desktop-mac-arm64` 或 `clipforge-desktop-mac-x64`。产物保留 14 天，包含安装包和 `smoke/` 验证证据。推送 `v*` tag 时，已通过验证的安装包会上传到草稿 Release；此 PR 本身不发布 Release。

安装后的验收使用含空格的临时路径和隔离用户数据，不读取现有 API Key，也不创建付费任务。它要求以下检查全部通过才输出 `SMOKE_OK`：

- `/api/project` 返回 200 和项目数组，实际执行数据库查询。
- 安装包内 FFmpeg、ffprobe 可运行 `-version`。
- 安装包内 SenseVoice 原生识别运行库可加载。
- 真实 Electron 渲染器加载 `/start`，网页和原生主题为亮色。

结果写入 `release/smoke/result.json`，运行日志写入 `runtime.log`，截图写入 `light-interface.png`。数据库错误、原生库缺失、深色页面和超时均使验收失败。该检查不包含 AI 生成服务、首次模型下载或签名公证验证。

## 官方参考

- [Electron 原生主题](https://www.electronjs.org/docs/latest/api/native-theme)
- [Electron 原生模块 ABI](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)
- [GitHub Actions runner 系统与架构](https://github.com/actions/runner-images#available-images)
