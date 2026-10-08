# whatsthis — development

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
| `src/search.ts` | `web_search` tool: scrapes the search result page |
| `src/deepseek.ts` | DeepSeek endpoint and model list |
| `src/config.ts` | Config read and write; throws on failure |
| `src/preload.mts` | `contextBridge` surface for both pages |
| `scripts/build-native.mjs` | Compiles `native/ax.m` to `build/ax.node` |
| `scripts/build-dmg.mjs` | Packages the `.app`, then builds the `.dmg` |
| `test/verify.mjs` | Module-level smoke tests |
| `test/e2e.mjs` | End-to-end against the real model |

## Why the Accessibility call needs a native extension

The AX call checks whether *the calling process* is authorized, and a subprocess does not inherit its parent's authorization. Shelling out to `osascript` or to a separate helper therefore does not work. `native/ax.m` is an N-API extension compiled into the Electron process, so the call is made from inside it. N-API is ABI-stable, which is why `electron-rebuild` and `node-gyp` are not needed.

## Launch at login

Launch at login defaults to on and takes effect only in a packaged `.app`. In development nothing is registered, because the path that would be registered points at a bare Electron with no app behind it.

## Providers

DeepSeek is the only provider. Another vendor requires changes to `src/deepseek.ts` and `resolveModel()`, and removing that vendor's SDK from `UNUSED_PROVIDERS` in `scripts/build-dmg.mjs`.

The model table in `pi-ai` marks DeepSeek as text-only. `resolveModel()` overrides it to accept images; a model that rejects images returns its error in the panel.

## Markdown rendering

Rendered Markdown escapes raw HTML and allows only `http`/`https` links; other schemes are stripped to plain text. Link clicks go through `shell.openExternal`, and the panel blocks `will-navigate`.

## License

MIT
