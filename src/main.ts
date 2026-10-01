import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	BrowserWindow,
	Menu,
	Tray,
	app,
	clipboard,
	dialog,
	ipcMain,
	nativeImage,
	screen,
	shell,
	systemPreferences,
} from "electron";
import type { ImageContent } from "@mariozechner/pi-ai";
import { CANCELLED, ask, type AskRun } from "./agent.js";
import { loadConfig, saveConfig, type Config } from "./config.js";
import { listModels } from "./deepseek.js";
import { contextFor, copyTextOf, createHistory, go, push, removeCurrent, viewOf, type Entry, type History } from "./history.js";
import { renderMarkdown, safeExternalUrl } from "./markdown.js";
import { describeSelectionAccess, inspectSelection } from "./selection.js";

const ROOT = app.getAppPath();
const PRELOAD = path.join(ROOT, "dist", "preload.mjs");
const QUESTION = "这是什么？";
/** 剪切板图片最长边超过这个值就先缩放，避免请求体过大被拒。 */
const MAX_IMAGE_EDGE = 2048;
/** 流式回答的 Markdown 重渲染间隔：太密浪费，太疏卡顿 */
const RENDER_INTERVAL_MS = 80;

let tray: Tray | null = null;
let panel: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let current: AskRun | null = null;
/** 浮窗最近一次 show() 的时间戳，用来过滤 show 之后立刻到达的假 blur。 */
let shownAt = 0;
/** 这次运行记下的问答，浮窗顶部左右箭头在它上面翻页。关掉浮窗不清空。 */
const history: History = createHistory();

/** 这条记录现在是不是正显示在浮窗里。翻页翻走了就别再动页面。 */
function isShown(entry: Entry): boolean {
	return history.entries[history.index] === entry;
}

function showEntry(win: BrowserWindow, entry: Entry): void {
	send(win, "panel:entry", viewOf(history, entry));
}

/** 构建 Model 需要的 apiKey + model 是否齐全。 */
function isConfigured(config: Config): boolean {
	return Boolean(config.apiKey.trim() && config.model.trim());
}

function send(win: BrowserWindow, channel: string, payload: unknown): void {
	if (!win.isDestroyed()) win.webContents.send(channel, payload);
}

/** 复用已有浮窗，没有就建一个，并等页面加载完（首次事件不能在加载前发出）。 */
async function ensurePanel(): Promise<BrowserWindow> {
	if (panel && !panel.isDestroyed()) return panel;

	const win = new BrowserWindow({
		width: 420,
		height: 360,
		show: false,
		frame: false,
		// 透明只为圆角：无边框窗口默认是直角，圆角外面那一圈得靠窗口透明露出来。
		// 面板本身是不透明的（见 panel.html 的 --bg），所以不会去采样窗口背后的内容。
		transparent: true,
		// 阴影交给 macOS 画，跟着窗口形状走；CSS box-shadow 会被窗口边缘裁成直线。
		hasShadow: true,
		resizable: false,
		movable: false,
		alwaysOnTop: true,
		skipTaskbar: true,
		webPreferences: {
			preload: PRELOAD,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});
	panel = win;
	void win.loadFile(path.join(ROOT, "src", "panel.html"));
	// 浮窗里点链接不能把页面导航走，一律交给系统浏览器
	win.webContents.on("will-navigate", (event) => event.preventDefault());
	win.on("blur", () => {
		// show() 刚执行完可能收到一次假 blur，忽略它，否则浮窗会立刻自己收回去
		if (Date.now() - shownAt < 250) return;
		win.hide();
		current?.abort();
		current = null;
	});
	win.on("closed", () => {
		panel = null;
	});

	if (win.webContents.isLoading()) {
		await new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
	}
	return win;
}

/** 把浮窗贴到菜单栏图标正下方，并夹在屏幕可见区域内。 */
function positionPanel(win: BrowserWindow): void {
	if (!tray) return;
	const anchor = tray.getBounds();
	const { width, height } = win.getBounds();
	const area = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }).workArea;
	const x = Math.min(Math.max(anchor.x + anchor.width / 2 - width / 2, area.x + 8), area.x + area.width - width - 8);
	const y = Math.min(Math.max(anchor.y + anchor.height + 6, area.y + 8), area.y + area.height - height - 8);
	win.setPosition(Math.round(x), Math.round(y), false);
}

function openSettings(): void {
	if (settingsWindow && !settingsWindow.isDestroyed()) {
		settingsWindow.show();
		settingsWindow.focus();
		return;
	}
	settingsWindow = new BrowserWindow({
		width: 460,
		height: 380,
		title: "What's This? 设置",
		show: false,
		resizable: false,
		webPreferences: {
			preload: PRELOAD,
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: false,
		},
	});
	settingsWindow.once("ready-to-show", () => settingsWindow?.show());
	settingsWindow.on("closed", () => {
		settingsWindow = null;
	});
	void settingsWindow.loadFile(path.join(ROOT, "src", "settings.html"));
}

type Clip = { kind: "image"; image: ImageContent; dataUrl: string } | { kind: "text"; text: string };

/** 读取剪切板。有图片就返回图片，否则返回文字。 */
async function readClipboard(): Promise<Clip> {
	const text = (await clipboard.readText()).trim();

	for (const item of await clipboard.read()) {
		const imageType = item.types.find((type) => type.startsWith("image/"));
		if (!imageType) continue;

		const blob = (await item.getType(imageType)) as Blob;
		let image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
		if (image.isEmpty()) continue;

		const { width, height } = image.getSize();
		const longest = Math.max(width, height);
		if (longest > MAX_IMAGE_EDGE) {
			const scale = MAX_IMAGE_EDGE / longest;
			image = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) });
		}

		const base64 = image.toPNG().toString("base64");
		return {
			kind: "image",
			image: { type: "image", data: base64, mimeType: "image/png" },
			dataUrl: `data:image/png;base64,${base64}`,
		};
	}

	return { kind: "text", text };
}

type Input =
	| { kind: "followup"; text: string }
	| { kind: "selection"; text: string }
	| { kind: "image"; image: ImageContent; dataUrl: string }
	| { kind: "text"; text: string }
	| { kind: "empty" };

const START_LOG = path.join(os.homedir(), ".whatsthis", "last-start.log");
const CLICK_LOG = path.join(os.homedir(), ".whatsthis", "last-click.log");

/** 菜单栏应用没有控制台，把关键状态写进日志，出问题时有据可查。 */
function writeLog(file: string, lines: string[]): void {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
		fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
	} catch {
		// 日志写不了不影响主流程
	}
}

/**
 * 第一次运行主动要一次「辅助功能」权限。
 * 不主动请求的话 macOS 不会把本应用登记进「系统设置 → 辅助功能」，
 * 用户想手动授权都找不到条目。
 */
function requestAccessibilityOnce(config: Config): void {
	const trusted = systemPreferences.isTrustedAccessibilityClient(false);
	writeLog(START_LOG, [
		`时间：${new Date().toLocaleString("zh-CN")}`,
		`本应用 pid：${process.pid}`,
		`辅助功能权限：${trusted ? "已授权" : "未授权"}`,
		`之前已请求过：${config.accessibilityPrompted ? "是" : "否"}`,
		inspectSelection().report,
	]);

	if (trusted || config.accessibilityPrompted) return;
	try {
		saveConfig({ ...config, accessibilityPrompted: true });
	} catch {
		// 存不下就下次启动再请求
	}
	// 稍等一下再弹，让菜单栏图标先出来
	setTimeout(() => systemPreferences.isTrustedAccessibilityClient(true), 1000);
}

/** 浮窗里此刻选中的文字。在答案里选一段话再点图标，就是就着这一轮追问。 */
async function readPanelSelection(win: BrowserWindow | null): Promise<string> {
	if (!win || win.isDestroyed()) return "";
	try {
		const text = await win.webContents.executeJavaScript("window.getSelection().toString()");
		return typeof text === "string" ? text.trim() : "";
	} catch {
		return "";
	}
}

/** 取材优先级：浮窗里选中的内容（追问）→ 鼠标选区 → 剪切板图片 → 剪切板文字。 */
async function gatherInput(): Promise<Input> {
	let report: string;
	let input: Input;

	const asked = await readPanelSelection(panel);
	if (asked) {
		report = `浮窗里选中了 ${asked.length} 个字符，判定为追问上一轮`;
		input = { kind: "followup", text: asked };
	} else if (systemPreferences.isTrustedAccessibilityClient(false)) {
		const reading = inspectSelection();
		report = reading.report;
		input = reading.text ? { kind: "selection", text: reading.text } : { kind: "empty" };
	} else {
		report = "没有「辅助功能」权限，跳过读选区（右键菜单 →「读取选区权限…」可以授权）";
		input = { kind: "empty" };
	}

	if (input.kind === "empty") {
		const clip = await readClipboard();
		input = clip.kind === "image" ? clip : clip.text ? clip : { kind: "empty" };
	}

	writeLog(CLICK_LOG, [
		`时间：${new Date().toLocaleString("zh-CN")}`,
		`本应用 pid：${process.pid}`,
		`取材结果：${input.kind}`,
		report,
	]);
	return input;
}

/** 去重键：同一个问题连着问两次只留最近一条。 */
function keyOf(input: Exclude<Input, { kind: "empty" }>): string {
	if (input.kind === "image") return input.dataUrl;
	return `${input.kind === "followup" ? "追问" : "取材"}:${input.text}`;
}

/**
 * 记录里只留了预览用的 data URL（内存里放一份就够了），
 * 真要发给模型时再还原成 pi-ai 的 ImageContent。
 */
function imageOf(dataUrl: string): ImageContent {
	return {
		type: "image",
		mimeType: dataUrl.slice(5, dataUrl.indexOf(";", 5)),
		data: dataUrl.slice(dataUrl.indexOf(",") + 1),
	};
}

/**
 * 点图标只做这一步：取材，把内容摆成一张卡片。
 *
 * **不发给模型**。剪切板里可能是密码、聊天记录，得等用户在浮窗里点一下内容框
 * （见 sendEntry）才真送出去。
 */
async function stageInput(input: Input, config: Config): Promise<void> {
	const win = await ensurePanel();
	positionPanel(win);
	shownAt = Date.now();
	win.show();

	current?.abort();
	current = null;

	if (input.kind === "empty") {
		send(win, "panel:notice", "没有选中的文字，剪切板也是空的 —— 先选一段文字或复制点什么。");
		return;
	}

	// 追问就着浮窗里正显示的那条继续；首次提问带原文，追问只问选中那句话
	const followUp = input.kind === "followup";
	const source = input.kind === "image" ? undefined : input.text;
	const entry = push(
		history,
		{
			kind: input.kind,
			model: config.model,
			key: keyOf(input),
			question: followUp ? input.text : source ? `${QUESTION}\n\n${source}` : QUESTION,
			text: source,
			dataUrl: input.kind === "image" ? input.dataUrl : undefined,
		},
		followUp,
	);
	showEntry(win, entry);
}

/** 用户点了内容框：这一张卡片的内容可以发了，跑起来。 */
async function sendEntry(entry: Entry, config: Config): Promise<void> {
	const win = await ensurePanel();
	if (!isShown(entry)) return;

	entry.status = "running";
	entry.model = config.model;
	showEntry(win, entry);

	// Markdown 每来一个分片都要整段重渲染，所以节流；收尾时再补一次完整渲染
	let answer = "";
	let timer: NodeJS.Timeout | null = null;
	const flush = () => {
		timer = null;
		entry.answer = answer;
		entry.html = renderMarkdown(answer);
		if (isShown(entry)) send(win, "panel:html", { id: entry.id, html: entry.html });
	};

	let run: AskRun | null = null;
	try {
		run = ask({
			apiKey: config.apiKey,
			model: config.model,
			question: entry.question,
			context: entry.kind === "followup" ? contextFor(history, entry) : undefined,
			image: entry.kind === "image" && entry.dataUrl ? imageOf(entry.dataUrl) : undefined,
			onDelta: (delta) => {
				answer += delta;
				if (!timer) timer = setTimeout(flush, RENDER_INTERVAL_MS);
			},
		});
		current = run;
		await run.done;
	} catch (err) {
		const message = (err as Error).message;
		// 中途关掉浮窗时，已经吐出来的半截回答留着就行，别把它换成一条报错
		if (message !== CANCELLED || !answer) entry.error = message;
	} finally {
		if (timer) clearTimeout(timer);
		entry.answer = answer;
		entry.html = renderMarkdown(answer);
		entry.status = "done";
		if (isShown(entry)) showEntry(win, entry);
		if (run && current === run) current = null;
	}
}

/** 点击图标 = 取材摆卡片，等用户点内容框才发送。 */
async function onTrayClick(): Promise<void> {
	const config = loadConfig();
	if (!isConfigured(config)) {
		openSettings();
		return;
	}
	// 必须先取材再 show()：show() 会让本应用成为前台，之后就取不到别的应用的选区了
	const input = await gatherInput();
	await stageInput(input, config);
}

/** 右键菜单里点「读取选区权限」：触发系统授权弹窗，并回报当前状态。 */
function showSelectionAccess(): void {
	const trusted = systemPreferences.isTrustedAccessibilityClient(true);
	const detail = describeSelectionAccess();
	void dialog.showMessageBox({
		type: "info",
		title: "读取选区",
		message: trusted ? "已获得「辅助功能」权限" : "尚未获得「辅助功能」权限",
		detail: trusted
			? detail
			: `${detail}\n\n去「系统设置 → 隐私与安全性 → 辅助功能」勾选本应用。开发模式下它是 node_modules 里的 Electron。`,
	});
}

function createTray(): void {
	const icon = nativeImage.createFromPath(path.join(ROOT, "assets", "trayTemplate.png"));
	icon.setTemplateImage(true);
	tray = new Tray(icon);
	tray.setToolTip("这是什么？");
	tray.on("click", () => void onTrayClick());
	tray.on("right-click", () => {
		tray?.popUpContextMenu(
			Menu.buildFromTemplate([
				{ label: "读取选区权限…", click: () => void showSelectionAccess() },
				{ label: "设置…", click: openSettings },
				{ type: "separator" },
				{ label: "退出", click: () => app.quit() },
			]),
		);
	});
}

/** IPC 统一返回 { ok, ... }，避免 Electron 把异常消息包成 "Error invoking remote method"。 */
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function guard<T>(fn: () => T | Promise<T>): Promise<Result<T>> {
	return Promise.resolve()
		.then(fn)
		.then((value) => ({ ok: true, value }) as const)
		.catch((err: unknown) => ({ ok: false, error: (err as Error).message }) as const);
}

ipcMain.handle("config:load", () => guard(() => loadConfig()));
ipcMain.handle("config:save", (_event, config: Config) =>
	guard(() => {
		saveConfig(config);
		return loadConfig();
	}),
);
ipcMain.handle("models:list", (_event, apiKey: string) => guard(() => listModels(apiKey)));
ipcMain.on("panel:page", (_event, delta: number) => {
	const entry = go(history, delta > 0 ? 1 : -1);
	if (panel && entry) showEntry(panel, entry);
});
ipcMain.on("panel:send", () => {
	const entry = history.entries[history.index];
	// 只有待发送的卡片能发；正在生成或已经答过的点了不动
	if (!entry || entry.status !== "pending") return;
	const config = loadConfig();
	if (!isConfigured(config)) {
		openSettings();
		return;
	}
	void sendEntry(entry, config);
});
ipcMain.on("panel:delete", () => {
	const win = panel;
	if (!win || win.isDestroyed()) return;
	// 删掉的可能正是还在生成的那条，请求一并停掉
	const gone = history.entries[history.index];
	const next = removeCurrent(history);
	if (gone?.status === "running") {
		current?.abort();
		current = null;
	}
	// next 为 null 表示删光了，让浮窗回到空状态
	if (next) showEntry(win, next);
	else send(win, "panel:entry", null);
});
ipcMain.on("panel:copy", () => {
	const entry = history.entries[history.index];
	if (entry) clipboard.writeText(copyTextOf(entry));
});
ipcMain.on("panel:cancel", () => {
	current?.abort();
	current = null;
});
ipcMain.on("panel:close", () => panel?.hide());
ipcMain.on("settings:close", () => settingsWindow?.close());
ipcMain.on("open-external", (_event, url: string) => {
	// 只放行 http/https，别让渲染出来的内容拿自定义 scheme 去拉起别的应用
	const safe = safeExternalUrl(url);
	if (safe) void shell.openExternal(safe);
});

app.whenReady().then(() => {
	// 纯菜单栏应用：藏掉 Dock 图标
	app.dock?.hide();
	createTray();
	const config = loadConfig();
	if (!isConfigured(config)) openSettings();
	requestAccessibilityOnce(config);
});

// 菜单栏应用：关掉所有窗口也不退出
app.on("window-all-closed", () => {});
