# whatsthis

**中文** · [English](README.md)

近来，ai智能体应用越做越重，似乎要代劳人在计算机上所有的操作。但我们真的需要一个无所不能的ai吗？还是只需要在它应该出现的地方出现？因此有了本项目：whatsthis。本项目仅仅是一个demo想法，用来尝试简化人和ai的对话流程，你可以选中内容并不断再次选中输出内容进行追问，在不输入任何一个问题的情况下获取所有你想知道的所有概念解释。 

whatsthis是一个macOS 菜单栏应用，基于 [`@mariozechner/pi-agent-core`](https://github.com/badlogic/pi-mono) 封装。使用时，选择或者复制你想知道的任何内容，应用会帮你提问：这是什么？应用始终放置在应用栏，不需要点击打开和输入对话。当你想要回看时，应用会最多维持50张卡片，每张卡片会在60分钟之后自动删除。

## 安装

从 [Releases](https://github.com/Shnani/whatsthis/releases/latest) 下载 `whatsthis-0.1.0-arm64.dmg`，打开后把 **whatsthis** 拖进「应用程序」。

仅支持 Apple Silicon。安装包没有 Developer ID 签名，首次启动会被 Gatekeeper 拦下。右键点应用选「打开」，或者清掉隔离属性：

```bash
xattr -cr /Applications/whatsthis.app
```

## 使用

左键点菜单栏图标取材，优先级如下：

1. 浮窗里选中的文字 —— 判定为追问
2. 别处选中的文字 —— 需要辅助功能权限
3. 剪切板里的图片
4. 剪切板里的文字

取材不发任何请求。浮窗把内容摆成一张卡片，标题栏标出来源；点内容框才发送，答案流式显示在下面。点浮窗外面或按 `Esc` 关闭，同时中断进行中的请求。

右键点图标：辅助功能权限 / 设置 / 退出。

答完之后内容框不再接受点击，手滑不会重复发送。想再问一次，重新点菜单栏图标。

## 记录

每次问答存在内存里，进程退出即丢失，上限 50 条 / 60 分钟。浮窗顶部的 `‹ 3/9 ›` 翻页，中间两个按钮删除当前这条、复制问题与回答全文。连着问同一个问题只保留最近一条。正在显示的那条不会被清理掉。

在旧回答里选中一段文字再点图标，是追问而不是新问题：选中的文字作为提问，该会话前几轮的问答作为上下文一起发出。

## 辅助功能权限

读别处选中的文字走 macOS 辅助功能 API，需要授权。首次启动会请求：在「系统设置 → 隐私与安全性 → 辅助功能」里勾选 **Electron**，然后重启应用。

列表里没有条目时点 `+` 手动添加 —— 开发模式是 `node_modules/electron/dist/Electron.app`，装好之后是 `/Applications/whatsthis.app`。没授权也能用，自动退回剪切板，不报错。

AX 调用必须发生在 Electron 进程内：子进程不继承父进程的授权，所以 shell 出去跑 `osascript` 或独立 helper 都不行。`native/ax.m` 是编进进程的 N-API 扩展。N-API 的 ABI 稳定，不需要 `electron-rebuild` 或 `node-gyp`。

## 配置

`~/.whatsthis/config.json`，权限 `0600`：

```json
{
  "apiKey": "sk-…",
  "model": "deepseek-v4-flash",
  "accessibilityPrompted": false,
  "launchAtLogin": true
}
```

Key 和模型在设置窗口里填。模型列表实时取自 `GET https://api.deepseek.com/models`，DeepSeek 上新模型不用改代码。

开机自启默认开启，只在打包成 `.app` 后生效。开发模式下不注册 —— 会被注册的路径指向一个没有应用的空 Electron。

## 构建

```bash
npm install
npm run build     # 先编原生扩展，再 tsc
npm run app       # 构建后脱离终端启动
npm run dist      # 产出 .app 和 .dmg，落在 release/

npm run verify    # 冒烟测试，不联网
npm run e2e       # 端到端，真调模型
```

需要 macOS 和 Xcode 命令行工具（`clang`）。原生扩展编译失败不会挡住构建，只是读选区功能失效。

`npm run e2e` 会用 `~/.whatsthis/config.json` 里的 Key 发几次很短的请求，并临时改写该文件来测设置窗口的保存路径。两个测试脚本都会备份并还原剪切板**文字**，还原不了图片。

## 目录

| 路径 | 作用 |
| --- | --- |
| `src/main.ts` | 主进程：托盘、右键菜单、取材 → 摆卡片、日志 |
| `src/contract.ts` | IPC 契约：channel 名与消息类型（不许 import `electron`） |
| `src/ipc.ts` | `ipcMain` 处理器 |
| `src/panel.ts`、`src/panel.html` | 结果浮窗 |
| `src/settings.ts`、`src/settings.html` | 设置窗口 |
| `src/input.ts` | 取材优先级：浮窗选区 → 选区 → 剪切板图片 → 剪切板文字 |
| `src/clipboard.ts` | 剪切板读取与图片缩放 |
| `src/ask.ts` | 跑一轮问答：节流渲染流式片段，落进某条记录 |
| `src/history.ts` | 记录：去重、翻页、追问上下文（纯函数，无 IO） |
| `src/markdown.ts` | Markdown → HTML，含 HTML 转义与链接过滤 |
| `native/ax.m` | N-API 扩展：进程内调辅助功能 API 读选中文字 |
| `src/selection.ts` | 加载扩展，整理结果 |
| `src/agent.ts` | `pi-agent-core` 封装 |
| `src/deepseek.ts` | DeepSeek 接口地址与模型列表 |
| `src/config.ts` | 配置读写，失败必抛异常 |
| `src/preload.mts` | 给两个页面暴露的 `contextBridge` |
| `scripts/build-native.mjs` | 编译 `native/ax.m` 到 `build/ax.node` |
| `scripts/build-dmg.mjs` | 打 `.app`，再压 `.dmg` |
| `test/verify.mjs` | 模块级冒烟测试 |
| `test/e2e.mjs` | 端到端，对真实模型 |

## 已知限制

- 渲染后的 Markdown 把原始 HTML 转义成文本，链接只放行 `http`/`https`，其余协议剥成纯文本。点链接走 `shell.openExternal`，浮窗拦截 `will-navigate`。
- `pi-ai` 的模型表把 DeepSeek 标成纯文本，`resolveModel()` 覆盖成接受图片。模型若拒绝图片，错误原样显示在浮窗里。
- 只支持 DeepSeek。换厂商要改 `src/deepseek.ts` 和 `resolveModel()`，还要把该厂商的 SDK 从 `scripts/build-dmg.mjs` 的 `UNUSED_PROVIDERS` 里去掉。
- 读选区要求焦点元素支持 `AXSelectedText`。浏览器、备忘录、PDF 阅读器通常可以，终端通常不行。
- 剪切板图片超过 2048px 先等比缩放再发送。
- 记录只活在内存里，退出即丢。
- 「浮窗里选中内容 = 追问」不看窗口有没有焦点，所以选中后先收起浮窗再点图标，仍会被当成追问。
- `.app` 未签名、未公证。

## 许可

MIT
