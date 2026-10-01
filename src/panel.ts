import path from "node:path";
import type { Rectangle } from "electron";
import { BrowserWindow, app, screen } from "electron";
import { CH, type AnswerChunk } from "./contract.js";
import type { EntryView } from "./history.js";

const PRELOAD = path.join(app.getAppPath(), "dist", "preload.mjs");
const HTML = path.join(app.getAppPath(), "src", "panel.html");

let win: BrowserWindow | null = null;
/** 最近一次 show() 的时间戳，用来过滤 show 之后立刻到达的假 blur。 */
let shownAt = 0;
/** 浮窗自己收起时的钩子，main 拿它停掉正在跑的请求。 */
let onHidden: () => void = () => {};

/** 装上「浮窗自己收起了」的钩子。启动时装一次。 */
export function setHiddenHandler(fn: () => void): void {
	onHidden = fn;
}

/** 复用已有浮窗，没有就建一个，并等页面加载完（首次事件不能在加载前发出）。 */
async function ensure(): Promise<BrowserWindow> {
	if (win && !win.isDestroyed()) return win;

	const created = new BrowserWindow({
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
	win = created;
	void created.loadFile(HTML);
	// 浮窗里点链接不能把页面导航走，一律交给系统浏览器
	created.webContents.on("will-navigate", (event) => event.preventDefault());
	created.on("blur", () => {
		// show() 刚执行完可能收到一次假 blur，忽略它，否则浮窗会立刻自己收回去
		if (Date.now() - shownAt < 250) return;
		created.hide();
		onHidden();
	});
	created.on("closed", () => {
		win = null;
	});

	if (created.webContents.isLoading()) {
		await new Promise<void>((resolve) => created.webContents.once("did-finish-load", () => resolve()));
	}
	return created;
}

/** 贴到菜单栏图标正下方并显示。anchor 传 null 就留在原地（比如菜单栏图标还没建好）。 */
export async function show(anchor: Rectangle | null): Promise<void> {
	const panel = await ensure();
	if (anchor) {
		const { width, height } = panel.getBounds();
		const area = screen.getDisplayNearestPoint({ x: anchor.x, y: anchor.y }).workArea;
		const x = Math.min(Math.max(anchor.x + anchor.width / 2 - width / 2, area.x + 8), area.x + area.width - width - 8);
		const y = Math.min(Math.max(anchor.y + anchor.height + 6, area.y + 8), area.y + area.height - height - 8);
		panel.setPosition(Math.round(x), Math.round(y), false);
	}
	shownAt = Date.now();
	panel.show();
}

/** 确保浮窗已建好并加载完，但不改变显隐。 */
export async function prepare(): Promise<void> {
	await ensure();
}

export function hide(): void {
	win?.hide();
}

function send(channel: string, payload: unknown): void {
	if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** 整条切换：新提问、翻页、删除补位、收尾都走这里。entry 为 null 表示空状态。 */
export function showEntry(entry: EntryView | null): void {
	send(CH.entry, entry);
}

/** 没东西可问之类的一次性提示，不进历史，也不影响翻页。 */
export function showNotice(message: string): void {
	send(CH.notice, message);
}

/** 流式片段。翻页翻走了由调用方负责别推过来。 */
export function sendChunk(chunk: AnswerChunk): void {
	send(CH.html, chunk);
}

/** 浮窗里此刻选中的文字。在答案里选一段话再点图标，就是就着这一轮追问。 */
export async function selection(): Promise<string> {
	if (!win || win.isDestroyed()) return "";
	try {
		const text = await win.webContents.executeJavaScript("window.getSelection().toString()");
		return typeof text === "string" ? text.trim() : "";
	} catch {
		return "";
	}
}
