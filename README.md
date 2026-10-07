# whatsthis

[中文](README.zh-CN.md) · **English**

A macOS menu bar app that asks a model exactly one question — *what is this?* — about whatever you have selected or copied. No chat window, no agent framework, no session to manage: the goal is a model on standby, not another interface to open.

## Install

Download `whatsthis-0.1.0-arm64.dmg` from [Releases](https://github.com/Shnani/whatsthis/releases/latest), open it, and drag **whatsthis** into Applications.

Apple Silicon only. The build carries no Developer ID signature, so Gatekeeper blocks the first launch. Right-click the app and choose **Open**, or clear the quarantine flag:

```bash
xattr -cr /Applications/whatsthis.app
```

## Usage

Left-click the menu bar icon to collect input, in this order:

1. Text selected inside the panel — treated as a follow-up
2. Text selected in another app — requires Accessibility permission
3. Image on the clipboard
4. Text on the clipboard

Collection makes no network request. The panel shows the content as a card labeled with its source; click the content box to send, and the answer streams in below. Click outside the panel or press `Esc` to close it and abort an in-flight request.

Right-click the icon for Accessibility permission, Settings, and Quit.

Once an answer arrives the content box stops accepting clicks, so a stray click cannot re-send. Click the tray icon again to ask again.

## History

Each exchange is kept in memory for the life of the process, capped at 50 entries and 60 minutes; the panel header pages through them (`‹ 3/9 ›`), deletes the current entry, and copies the full question and answer. Asking the same question twice in a row keeps only the latest entry. The entry currently on screen is never evicted.

Selecting text inside a previous answer and then clicking the tray icon asks a follow-up rather than a new question. The selection becomes the prompt, and earlier turns of that conversation are sent as context.

## Accessibility permission

Reading the selection in other apps uses the macOS Accessibility API, which requires authorization. The app requests it on first launch: enable **Electron** in System Settings → Privacy & Security → Accessibility, then restart the app.

If the app is not listed, add it with the `+` button — `node_modules/electron/dist/Electron.app` in development, `/Applications/whatsthis.app` once installed. Without the permission the app falls back to the clipboard silently.

The AX call has to be made from inside the Electron process; a subprocess does not inherit its parent's authorization, so shelling out to `osascript` or to a separate helper does not work. `native/ax.m` is an N-API extension compiled into the process. N-API is ABI-stable, so `electron-rebuild` and `node-gyp` are not needed.

## Configuration

`~/.whatsthis/config.json`, mode `0600`:

```json
{
  "apiKey": "sk-…",
  "model": "deepseek-v4-flash",
  "accessibilityPrompted": false,
  "launchAtLogin": true
}
```

Set the key and model from the Settings window. The model list is fetched live from `GET https://api.deepseek.com/models`; new DeepSeek models show up without a code change.

Launch at login defaults to on and takes effect only in a packaged `.app`. In development nothing is registered, because the path that would be registered points at a bare Electron with no app behind it.

## Build

```bash
npm install
npm run build     # native extension, then tsc
npm run app       # build, then launch detached from the terminal
npm run dist      # packaged .app and .dmg in release/

npm run verify    # smoke tests, no network
npm run e2e       # end-to-end, real model calls
```

Requires macOS and the Xcode command line tools for `clang`. If the native extension fails to compile, the build still succeeds and selection reading is disabled.

`npm run e2e` issues a few short requests with the key from `~/.whatsthis/config.json` and briefly rewrites that file to exercise the Settings save path. Both test scripts back up and restore clipboard *text*, not clipboard images.

## Layout

| Path | Role |
| --- | --- |
| `src/main.ts` | Main process: tray, context menu, collect → build card, logging |
| `src/contract.ts` | IPC contract: channel names and message types (must not import `electron`) |
| `src/ipc.ts` | `ipcMain` handlers |
| `src/panel.ts`, `src/panel.html` | Result panel |
| `src/settings.ts`, `src/settings.html` | Settings window |
| `src/input.ts` | Input priority: panel selection → selection → clipboard image → clipboard text |
| `src/clipboard.ts` | Clipboard reading and image downscaling |
| `src/ask.ts` | One request: throttled streaming render into a history entry |
| `src/history.ts` | History: dedupe, paging, follow-up context (pure, no I/O) |
| `src/markdown.ts` | Markdown → HTML with HTML escaping and link filtering |
| `native/ax.m` | N-API extension: reads the selection through the Accessibility API |
| `src/selection.ts` | Loads the extension, formats its result |
| `src/agent.ts` | `pi-agent-core` wrapper |
| `src/deepseek.ts` | DeepSeek endpoint and model list |
| `src/config.ts` | Config read and write; throws on failure |
| `src/preload.mts` | `contextBridge` surface for both pages |
| `scripts/build-native.mjs` | Compiles `native/ax.m` to `build/ax.node` |
| `scripts/build-dmg.mjs` | Packages the `.app`, then builds the `.dmg` |
| `test/verify.mjs` | Module-level smoke tests |
| `test/e2e.mjs` | End-to-end against the real model |

## Limitations

- Rendered Markdown escapes raw HTML and allows only `http`/`https` links; other schemes are stripped to plain text. Link clicks go through `shell.openExternal`, and the panel blocks `will-navigate`.
- The model table in `pi-ai` marks DeepSeek as text-only. `resolveModel()` overrides it to accept images; a model that rejects images returns its error in the panel.
- DeepSeek is the only provider. Another vendor requires changes to `src/deepseek.ts` and `resolveModel()`.
- Selection reading needs the focused element to expose `AXSelectedText`. Browsers, Notes, and PDF readers generally do; terminals generally do not.
- Clipboard images larger than 2048 px are downscaled before sending.
- History lives only in memory and is lost on quit.
- The "selected text in the panel means follow-up" rule does not check window focus, so selecting text and collapsing the panel before clicking the tray icon still registers as a follow-up.
- The `.app` is unsigned and unnotarized.

## License

MIT
