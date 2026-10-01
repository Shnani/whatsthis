import path from "node:path";
import { BrowserWindow, app } from "electron";

const PRELOAD = path.join(app.getAppPath(), "dist", "preload.mjs");
const HTML = path.join(app.getAppPath(), "src", "settings.html");

let win: BrowserWindow | null = null;

/** 打开设置窗口；已经开着就把它提到前面。 */
export function openSettings(): void {
	if (win && !win.isDestroyed()) {
		win.show();
		win.focus();
		return;
	}
	win = new BrowserWindow({
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
	win.once("ready-to-show", () => win?.show());
	win.on("closed", () => {
		win = null;
	});
	void win.loadFile(HTML);
}

export function closeSettings(): void {
	win?.close();
}
