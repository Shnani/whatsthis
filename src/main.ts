import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Menu, Tray, app, clipboard, dialog, nativeImage, systemPreferences } from "electron";
import { runAsk, type AskHandle } from "./ask.js";
import { loadConfig, saveConfig, type Config } from "./config.js";
import { copyTextOf, createHistory, go, push, removeCurrent, viewOf, type Entry, type History } from "./history.js";
import { gatherInput, keyOf, type Input } from "./input.js";
import { registerIpc } from "./ipc.js";
import { applyLaunchAtLogin } from "./login-item.js";
import * as panel from "./panel.js";
import { describeSelectionAccess, inspectSelection } from "./selection.js";
import { closeSettings, openSettings } from "./settings.js";

const ROOT = app.getAppPath();
const QUESTION = "这是什么？";
const START_LOG = path.join(os.homedir(), ".whatsthis", "last-start.log");
const CLICK_LOG = path.join(os.homedir(), ".whatsthis", "last-click.log");

let tray: Tray | null = null;
/** 正在跑的那一轮，用来中断。 */
let current: AskHandle | null = null;
/** 这次运行记下的问答，浮窗顶部左右箭头在它上面翻页。关掉浮窗不清空。 */
const history: History = createHistory();

/** 构建 Model 需要的 apiKey + model 是否齐全。 */
function isConfigured(config: Config): boolean {
	return Boolean(config.apiKey.trim() && config.model.trim());
}

/** 这条记录现在是不是正显示在浮窗里。翻页翻走了就别再动页面。 */
function isShown(entry: Entry): boolean {
	return history.entries[history.index] === entry;
}

function abortCurrent(): void {
	current?.abort();
	current = null;
}

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

/**
 * 点图标只做这一步：取材，把内容摆成一张卡片。
 *
 * **不发给模型**。剪切板里可能是密码、聊天记录，得等用户在浮窗里点一下内容框
 * （见 sendEntry）才真送出去。
 */
async function stageInput(input: Input, config: Config): Promise<void> {
	await panel.show(tray ? tray.getBounds() : null);
	abortCurrent();

	if (input.kind === "empty") {
		panel.showNotice("没有选中的文字，剪切板也是空的 —— 先选一段文字或复制点什么。");
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
	panel.showEntry(viewOf(history, entry));
}

/** 用户点了内容框：这一张卡片的内容可以发了，跑起来。 */
async function sendEntry(entry: Entry, config: Config): Promise<void> {
	await panel.prepare();
	if (!isShown(entry)) return;

	entry.status = "running";
	entry.model = config.model;
	panel.showEntry(viewOf(history, entry));

	abortCurrent();
	const handle = runAsk({
		entry,
		history,
		config,
		deliver: (html) => {
			if (isShown(entry)) panel.sendChunk({ id: entry.id, html });
		},
	});
	current = handle;
	try {
		await handle.done;
		if (isShown(entry)) panel.showEntry(viewOf(history, entry));
	} finally {
		if (current === handle) current = null;
	}
}

/** 点击菜单栏图标 = 取材摆卡片，等用户点内容框才发送。导出让端到端测试能直接驱动这条链路。 */
export async function onTrayClick(): Promise<void> {
	const config = loadConfig();
	if (!isConfigured(config)) {
		openSettings();
		return;
	}
	// 必须先取材再 show()：show() 会让本应用成为前台，之后就取不到别的应用的选区了
	const { input, report } = await gatherInput();
	writeLog(CLICK_LOG, [
		`时间：${new Date().toLocaleString("zh-CN")}`,
		`本应用 pid：${process.pid}`,
		`取材结果：${input.kind}`,
		report,
	]);
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

/** 渲染进程发来的操作。碰状态的部分在这里实现，纯转发的在 ipc.ts 里。 */
registerIpc({
	page: (delta) => {
		const entry = go(history, delta);
		if (entry) panel.showEntry(viewOf(history, entry));
	},
	send: () => {
		const entry = history.entries[history.index];
		// 只有待发送的卡片能发；正在生成或已经答过的点了不动
		if (!entry || entry.status !== "pending") return;
		const config = loadConfig();
		if (!isConfigured(config)) {
			openSettings();
			return;
		}
		void sendEntry(entry, config);
	},
	remove: () => {
		// 删掉的可能正是还在生成的那条，请求一并停掉
		const gone = history.entries[history.index];
		const next = removeCurrent(history);
		if (gone?.status === "running") abortCurrent();
		// next 为 null 表示删光了，让浮窗回到空状态
		panel.showEntry(next ? viewOf(history, next) : null);
	},
	copy: () => {
		const entry = history.entries[history.index];
		if (entry) clipboard.writeText(copyTextOf(entry));
	},
	close: () => panel.hide(),
	closeSettings,
});

app.whenReady().then(() => {
	// 纯菜单栏应用：藏掉 Dock 图标
	app.dock?.hide();
	// 点浮窗外面收起来 = 放弃这一轮
	panel.setHiddenHandler(abortCurrent);
	createTray();
	const config = loadConfig();
	// 让登录项与配置一致。老配置文件没这个字段，读出来就是默认的开
	applyLaunchAtLogin(config.launchAtLogin);
	if (!isConfigured(config)) openSettings();
	requestAccessibilityOnce(config);
});

// 菜单栏应用：关掉所有窗口也不退出
app.on("window-all-closed", () => {});
