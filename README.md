# whatsthis

[中文](README.zh-CN.md) · **English**

AI agent apps keep getting heavier, as if they were meant to take over everything you do on a computer. But do you really want an AI that can do anything — or one that shows up where it should? That question is what this project is: a demo idea for simplifying the conversation between a person and a model. You select something, then keep selecting from the output to follow up, and get every concept you care about explained without typing a single question.

whatsthis is a macOS menu bar app wrapping [`@mariozechner/pi-agent-core`](https://github.com/badlogic/pi-mono). Select or copy anything you want explained, and the app asks on your behalf: *what is this?* It stays in the menu bar — nothing to open, no prompt to type. When you want to look back, it holds at most 50 cards, each deleted 60 minutes after it was created.

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

The model has a `web_search` tool and decides on its own whether to call it — for news, versions, and prices, and for facts it is unsure about; not for explaining code or common terms. While it searches, the panel says `正在搜索网络…` and the answer comes back with source links.

Once an answer arrives the content box stops accepting clicks, so a stray click cannot re-send. Click the icon again to ask again.

## History

Exchanges are kept in memory until the app quits, capped at 50 entries and 60 minutes. The panel header pages through them (`‹ 3/9 ›`), deletes the current entry, and copies its full question and answer. Asking the same question twice in a row keeps only the latest. The entry on screen is never evicted.

Select text inside a previous answer, then click the tray icon: that is a follow-up, not a new question. The selection becomes the prompt, and earlier turns of the same conversation are sent as context.

## Accessibility permission

Reading the selection in other apps uses the macOS Accessibility API, which requires authorization. The app requests it on first launch: enable **Electron** in System Settings → Privacy & Security → Accessibility, then restart the app.

If the app is not listed, add it with the `+` button — `node_modules/electron/dist/Electron.app` in development, `/Applications/whatsthis.app` once installed. Without the permission the app falls back to the clipboard silently.

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

## Limitations

- Rendered Markdown allows only `http`/`https` links; other schemes and raw HTML show as plain text.
- DeepSeek is the only provider.
- Selection reading needs the focused element to expose `AXSelectedText`. Browsers, Notes, and PDF readers generally do; terminals generally do not.
- Clipboard images larger than 2048 px are downscaled before sending.
- `web_search` is scraping: it requests the search result page and pulls titles, links, and snippets out of the HTML. A redesign, a bot check, or rate limiting breaks it, and it then throws instead of silently answering from memory. It also sends the query the model wrote to that search engine — a second outbound path besides DeepSeek.
- History lives only in memory and is lost on quit.
- The "selected text in the panel means follow-up" rule does not check window focus, so selecting text and collapsing the panel before clicking the tray icon still registers as a follow-up.
- The `.app` is unsigned and unnotarized.

## Development

Build commands, project layout, and implementation notes: [DEVELOPMENT.md](DEVELOPMENT.md).

## License

MIT
