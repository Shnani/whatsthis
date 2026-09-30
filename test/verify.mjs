// 冒烟测试：npm run verify
// 1) 用 Electron 44 的新异步 clipboard API 走一遍 src/main.ts 里的读取逻辑
// 2) 驱动 panel.html，确认 preload 通道和 DOM 更新正常
// 注意：会临时改写系统剪切板，结束时恢复原文字（原来的图片不会还原）。
import { ClipboardItem, app, BrowserWindow, clipboard, ipcMain, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_IMAGE_EDGE = 2048;
const PNG_1PX =
	"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";

/** 与 src/main.ts 的 readClipboard 保持一致 */
async function readClipboard() {
	const text = (await clipboard.readText()).trim();
	for (const item of await clipboard.read()) {
		const imageType = item.types.find((t) => t.startsWith("image/"));
		if (!imageType) continue;
		const blob = await item.getType(imageType);
		let image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
		if (image.isEmpty()) continue;
		const { width, height } = image.getSize();
		const longest = Math.max(width, height);
		if (longest > MAX_IMAGE_EDGE) {
			const scale = MAX_IMAGE_EDGE / longest;
			image = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) });
		}
		return { kind: "image", size: image.getSize(), base64Len: image.toPNG().toString("base64").length };
	}
	return { kind: "text", text };
}

async function main() {
	const saved = await clipboard.readText();
	const savedImage = clipboard.read(); // 仅用于长度判断，下面不还原图片

	try {
		// --- 1. 文本分支 ---
		await clipboard.writeText("hello from verify");
		console.log("text   ->", JSON.stringify(await readClipboard()));

		// --- 2. 图片分支（新 API 写入一块 PNG） ---
		const buf = nativeImage.createFromBuffer(Buffer.from(PNG_1PX, "base64")).toPNG();
		await clipboard.write([new ClipboardItem({ "image/png": new Blob([buf], { type: "image/png" }) })]);
		console.log("image  ->", JSON.stringify(await readClipboard()));

		// --- 3. 渲染进程 wiring ---
		const win = new BrowserWindow({
			show: false,
			webPreferences: {
				preload: path.join(ROOT, "dist", "preload.mjs"),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: false,
			},
		});
		await win.loadFile(path.join(ROOT, "src", "panel.html"));

		const api = (expr) => win.webContents.executeJavaScript(expr);
		console.log("bridge ->", await api("typeof window.whatsthis"));

		win.webContents.send("answer:start", {
			kind: "image",
			model: "deepseek-v4-flash",
			dataUrl: `data:image/png;base64,${buf.toString("base64")}`,
		});
		win.webContents.send("answer:html", "<p>这是一张<strong>图片</strong>。</p>");
		win.webContents.send("answer:done", null);
		await new Promise((r) => setTimeout(r, 300));
		console.log(
			"panel  ->",
			await api(
				"JSON.stringify({model:document.getElementById('model').textContent,answer:document.getElementById('answer').textContent,bold:!!document.querySelector('#answer strong'),cursor:document.getElementById('answer').classList.contains('cursor'),img:document.querySelector('#preview img')?'ok':'missing'})",
			),
		);

		// --- 4. 错误分支 ---
		win.webContents.send("answer:error", "boom");
		await new Promise((r) => setTimeout(r, 200));
		console.log(
			"error  ->",
			await api(
				"JSON.stringify({answer:document.getElementById('answer').textContent,isError:document.getElementById('answer').classList.contains('error')})",
			),
		);

		console.log("savedImage items:", (await savedImage).length);

		// --- 5. settings.html（用桩 handler 验证 IPC 往返与 ok/error 分支） ---
		ipcMain.handle("config:load", () => ({ ok: true, value: { apiKey: "", model: "" } }));
		ipcMain.handle("models:list", () => ({
			ok: true,
			value: [
				{ id: "deepseek-v4-flash", name: "deepseek-v4-flash" },
				{ id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
			],
		}));
		ipcMain.handle("config:save", () => ({ ok: true, value: { apiKey: "sk-test", model: "deepseek-v4-pro" } }));

		const sw = new BrowserWindow({
			show: false,
			webPreferences: {
				preload: path.join(ROOT, "dist", "preload.mjs"),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: false,
			},
		});
		await sw.loadFile(path.join(ROOT, "src", "settings.html"));
		const sapi = (expr) => sw.webContents.executeJavaScript(expr);
		console.log("settings bridge ->", await sapi("typeof window.whatsthis"));

		await sapi("document.getElementById('apiKey').value='sk-test'; document.getElementById('fetch').click();");
		await new Promise((r) => setTimeout(r, 400));
		console.log(
			"settings fetch  ->",
			await sapi(
				"JSON.stringify({options:document.getElementById('model').options.length,enabled:!document.getElementById('model').disabled,status:document.getElementById('status').textContent,saveDisabled:document.getElementById('save').disabled})",
			),
		);

		await sapi("document.getElementById('save').click();");
		await new Promise((r) => setTimeout(r, 300));
		console.log("settings save   ->", await sapi("document.getElementById('status').textContent"));

		// --- 6. 选区读取：未授权时应静默返回空串，不能抛异常 ---
		const { inspectSelection } = await import("../dist/selection.js");
		const reading = inspectSelection();
		console.log("selection text  ->", JSON.stringify(reading.text));
		console.log("selection report:\n" + reading.report.replace(/^/gm, "  "));

		// --- 7. Markdown：转义原始 HTML，剥掉非 http/https 链接 ---
		const { renderMarkdown } = await import("../dist/markdown.js");
		const md = renderMarkdown("# 标题\n\n- **粗体**\n\n<script>alert(1)</script>\n\n[安全](https://example.com) [危险](javascript:alert(1))");
		console.log(
			"markdown ->",
			JSON.stringify({
				heading: md.includes("<h1>标题</h1>"),
				bold: md.includes("<strong>粗体</strong>"),
				scriptEscaped: md.includes("&lt;script&gt;") && !md.includes("<script>"),
				safeLink: md.includes('href="https://example.com"'),
				dangerousLinkStripped: !md.includes("javascript:"),
			}),
		);
	} catch (err) {
		console.error("FAILED:", err);
	} finally {
		await clipboard.writeText(saved);
		console.log("clipboard text restored");
		app.exit(0);
	}
}

app.whenReady().then(main);
