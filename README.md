# What's This?

macOS 菜单栏插件：点一下菜单栏图标，把**鼠标选中的文字**（或剪切板内容）丢给 AI，问「这是什么？」，答案流式显示在图标下方的浮窗里。

基于 [`@mariozechner/pi-agent-core`](https://github.com/badlogic/pi-mono) 构建，模型走 DeepSeek 官方 API。

## 用法

```bash
npm install
npm run app
```

- 首次启动会弹出设置窗口：填入 DeepSeek API Key → 点「获取模型列表」→ 选一个模型 → 保存。
- 之后**左键点菜单栏图标**：取材 → 浮窗把内容摆成一张卡片（此时还没有任何网络请求）。
- **点一下浮窗里的内容框**，才真的发给模型，答案流式显示在下面。
- 浮窗顶部 `‹ 3/9 ›` 翻页，`🗑` 删除当前这条，`⧉` 复制问题与回答，见「记忆与追问」。
- **右键点图标**：读取选区权限… / 设置… / 退出。
- 点浮窗外面或按 `Esc` 关闭，并中断正在进行的请求。

取材优先级（浮窗标题栏会显示这次用的是哪一种）：

1. **浮窗里选中的文字** —— 判定为追问上一轮，见「记忆与追问」
2. 鼠标选中文字 —— 需要「辅助功能」权限，见下
3. 剪切板里的图片
4. 剪切板里的文字

## 内容不会自己发出去

点菜单栏图标**只取材，不发请求**。内容先摆成一张卡片，标题栏标出来源，内容框底下写着
「点这里发送给 AI」，边框是强调色。**点一下内容框才真的发出去**，那时才产生网络请求。

剪切板里可能是密码、验证码、聊天记录，而「点一下图标」不该等价于「把内容送出本机」，
所以中间留了这一道手动确认。在此之前，内容只在本机内存里。

答完之后内容框就不可点了，免得手滑重复发；想再问一次，重新点菜单栏图标。

## 记忆与追问

每次问答都记在内存里（关掉浮窗不清空）。浮窗顶部：`‹ 3/9 ›` 在记录之间翻页，中间的 `🗑 ⧉` 是这张卡片的
操作 —— 垃圾桶删掉当前这条（删完自动显示顶上来的那条，删光了显示空状态），
复制按钮把**问题加回答全文**拷进剪切板（首次提问复制的是原文，追问复制的是那句追问；
拷完图标会变成对勾）。最右边的 `✕` 是关窗口。

记录活不过 60 分钟，也不超过 50 条 —— 超了丢最早的一条。清理发生在**每次触碰历史**的时候
（新提问 / 翻页 / 删除 / 取追问上下文），**正显示在浮窗里的那条不会被清**，
免得读到一半卡片自己没了；等你看别处了，下一次触碰才轮到它。

**去重**：连着问同一个问题只保留最近一条。比如选区没变，连点两次图标，历史里只会有一条
（后一次的答案覆盖前一次）。去重看的是「取材内容 + 是不是追问」，中间隔了别的问题就不算连续。

**追问**：在浮窗的答案里选一段话，再点菜单栏图标，这次就不问「这是什么？」了，
而是把那句话当作追问，并把同一条会话里前几轮的问答一起发给模型（见 `contextFor()`），
模型由此知道「这」指的是什么。追问沿用被追问那条的会话编号 —— 往回翻到旧的一条再选中追问，
接的是那条的上下文，不是最新的。追问记录在标题栏标成「追问」，同样要点一下内容框才发出。

关掉浮窗会中断正在进行的请求，但已经吐出来的半截回答会留在记录里，不会再被换成一条「已取消」的报错。

## 回答渲染

模型返回的内容按 Markdown 渲染（`marked`，GFM + 单换行即换行），支持标题、列表、**粗体**、
`行内代码`、代码块、引用、表格、分割线。渲染在主进程完成，节流 80ms 重渲染一次。

两条安全约束（[src/markdown.ts](src/markdown.ts)）：

- **原始 HTML 一律转义成文本**。模型可能把你剪切板里的 HTML 片段原样吐回来，
  直接 `innerHTML` 就是注入。既然 renderer 的 CSP 允许 `'unsafe-inline'`，这一步不能省。
- **链接只放行 http/https**，`javascript:` / `data:` / `file:` 会被剥成纯文本。
  点链接走 `shell.openExternal`，同时给浮窗挂了 `will-navigate` 拦截，页面不会被导航走。

## 读选区要开权限

读「别的地方选中的文字」走的是 macOS Accessibility API，必须先授权。
应用第一次启动会自动请求，弹窗里点「打开系统设置」，然后在
「系统设置 → 隐私与安全性 → 辅助功能」里勾选 **Electron**，再重启应用。

列表里没有条目时，点列表左下角 `+` 手动添加：

```
node_modules/electron/dist/Electron.app
```

没授权也能用，只是自动退回读剪切板，不会报错。

### 为什么必须用原生扩展

AX 调用查的是**发起调用的那个进程**有没有授权，**子进程不继承父进程的授权**。
所以下面这些路都走不通：

| 做法 | 结果 |
| --- | --- |
| `osascript` 跑 JXA + ObjC 桥 | ✗ Electron 自己 `isTrustedAccessibilityClient=true`，但它 spawn 的 osascript 调 AX 返回 `kAXErrorCannotComplete` |
| 独立 Swift/ObjC helper | ✗ 同样要用户单独给 helper 授权，且重编译会换签名 |
| Electron 内置 API | ✗ 不存在 |

只有把 AX 调用**编进 Electron 进程内**才行。[native/ax.m](native/ax.m) 是一个 N-API 扩展，
用 node 头文件编一次即可，**不需要 electron-rebuild / node-gyp**（N-API 是 ABI 稳定的）：

```bash
npm run build:native   # clang -bundle → build/ax.node
```

编译失败不会挡住整个构建，只是读选区功能失效、自动退回剪切板。

### 排查错误码

AXError 的取值以 SDK 里的 `AXError.h` 为准，**别凭记忆**——
`-25204` 是 `kAXErrorCannotComplete`，`-25211` 才是 `kAXErrorAPIDisabled`，很容易搞混。

### 出问题时看日志

菜单栏应用没有控制台，关键状态写在：

- `~/.whatsthis/last-start.log` —— 启动时的授权状态 + AX 探测结果
- `~/.whatsthis/last-click.log` —— 每次点图标的取材链路

`last-click.log` 会明确告诉你是哪一环断了：

```
取材结果：selection / text / image
选中文字：N 个字符
读选区：成功 / 无法完成（…没有权限） / 没有值（…没有选中内容）
读焦点元素：成功（AXTextArea） / …
读焦点应用：成功 / …
AX 焦点应用：pid=… Xxx       ← AX 认为谁有键盘焦点
系统前台应用：pid=… Xxx       ← 系统认为谁在前台
```

## 配置

存在 `~/.whatsthis/config.json`（权限 `0600`）：

```json
{
  "apiKey": "sk-…",
  "model": "deepseek-v4-flash",
  "accessibilityPrompted": false
}
```

模型列表是从 `GET https://api.deepseek.com/models` 实时拉的，所以 DeepSeek 上新模型后不用改代码，重新点一次「获取模型列表」即可。

## 结构

| 文件 | 作用 |
| --- | --- |
| [src/main.ts](src/main.ts) | Electron 主进程：Tray、浮窗、设置窗口、取材顺序、IPC |
| [src/history.ts](src/history.ts) | 问答记忆：去重、翻页、追问上下文（纯函数，无 IO） |
| [src/markdown.ts](src/markdown.ts) | Markdown → HTML（marked），含转义与链接过滤 |
| [native/ax.m](native/ax.m) | N-API 原生扩展：进程内调 Accessibility API 读选中文字 |
| [src/selection.ts](src/selection.ts) | 加载原生扩展，把结果整理成人话报告 |
| [src/agent.ts](src/agent.ts) | 封装 pi-agent-core，把内容交给模型 |
| [src/deepseek.ts](src/deepseek.ts) | 拉取 DeepSeek 官方模型列表 |
| [src/config.ts](src/config.ts) | 配置读写（失败必抛异常） |
| [src/preload.mts](src/preload.mts) | contextBridge，暴露给两个页面 |
| [src/panel.html](src/panel.html) | 结果浮窗（流式输出） |
| [src/settings.html](src/settings.html) | 设置窗口 |
| [test/verify.mjs](test/verify.mjs) | 冒烟测试：剪切板、选区、记忆去重/翻页、两个页面的 wiring |

## 开发

```bash
npm run watch         # tsc --watch
npm run build         # 编译原生扩展 + tsc
npm run build:native  # 只编译原生扩展
npm run app           # 构建 + 脱离终端启动（日常用这个）
npm start             # 构建 + 终端前台启动（要看 stdout 时用）
npm run verify        # 冒烟测试（会临时改写系统剪切板，跑完恢复原文字）
```

改 `src/*.html` 不需要编译，重启生效。

> 用 `npm run app` 而不是 `npm start`：前者走 `open`，进程父级是 launchd、脱离终端；
> 后者前台跑，关掉终端应用就没了。授权方面两者都能拿到（实测
> `isTrustedAccessibilityClient` 在两种启动方式下都返回 true），但日常用脱离终端的方式。

## 已知限制

- **取材在浮窗 `show()` 之前完成**。虽然现在读选区是同步的，但保持这个顺序更稳妥。
- **图片输入**：pi-ai 0.73.0 的模型表把 DeepSeek 标成纯文本（`input: ["text"]`），[src/agent.ts](src/agent.ts) 的 `resolveModel()` 会覆盖成 `["text", "image"]`。如果 DeepSeek 对某个模型返回「不支持图片」之类的错误，浮窗会原样显示该错误。
- **只支持 DeepSeek**。换别的厂商要改 `src/deepseek.ts` 和 `resolveModel()`。
- 选区读得到的前提是当前焦点元素支持 `AXSelectedText`。浏览器、备忘录、PDF 阅读器通常可以；终端里选中一般读不到。
- 剪切板图片超过 2048px 会先等比缩放再发送。
- **记忆只活在这次运行里**，退出应用就没了（没落盘）。要跨重启保留得往 `~/.whatsthis/` 里写。
- 「在浮窗里选中内容 = 追问」不看窗口有没有焦点，只看此刻浮窗里有没有选中文字（`window.getSelection()`）。
  所以选中后先把浮窗收起来、再复制别的东西点图标，会被当成对那条回答的追问，而不是新问题。

## 打包成 .app

未内置打包配置。需要时：

```bash
npx @electron/packager . Whatsthis --platform=darwin --overwrite
```

打包时要确保 `build/ax.node` 和 `src/` `assets/` 一起进 `Contents/Resources/app`。
若要在辅助功能列表里显示成「What's This?」而不是「Electron」，必须打包成带自己
bundle id 的 `.app`；开发模式下的授权对象是 `node_modules` 里那份 Electron。

若要隐藏 Dock 图标（纯菜单栏应用），在打包产物的 `Info.plist` 里加 `LSUIElement = true`。

### 国内网络

Electron 二进制从 GitHub Releases 下载，网络不通时：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install
```
