import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * 读鼠标选中文字走进程内的原生扩展 native/ax.m（编译产物 build/ax.node）。
 *
 * 曾经用 `osascript` 跑 JXA + ObjC 桥，**行不通**：AX 调用查的是发起进程的辅助功能授权，
 * 子进程不继承父进程的。实测 Electron 自己 isTrustedAccessibilityClient=true，
 * 但它 spawn 的 osascript 调 AX 依然返回 -25204（kAXErrorAPIDisabled）。
 * 所以必须编进 Electron 进程内 —— N-API 是 ABI 稳定的，用 node 头文件编一次即可，
 * 不需要 electron-rebuild。
 */
export interface Probe {
	text: string;
	/** 读系统级「当前焦点应用」的结果码。Chromium 系应用这里会是 -25212（NoValue） */
	appErr: number;
	elementErr: number;
	selectErr: number;
	/** AX 认为当前有键盘焦点的应用 */
	axAppPid: number;
	axAppName: string;
	/** 焦点元素的 AXRole，例如 AXTextArea */
	axRole: string;
	/** 系统级前台应用（不需要权限就能拿到） */
	frontPid: number;
	frontName: string;
	/** 本进程 pid，用来判断前台应用是不是被自己抢走了 */
	selfPid: number;
	/** 是否退回了「按前台 pid 建应用元素」这条路径 */
	usedFallback: boolean;
	/** 退回路径下轮询焦点元素用了几次 */
	elementAttempts: number;
	/** 上一个不是自己的前台应用 pid，点图标把自己变成前台时靠它兜底 */
	lastOtherPid: number;
}

interface NativeAddon {
	readFocusedSelection(): Probe;
}

let addon: NativeAddon | null = null;
let loadError = "";

try {
	addon = require("../build/ax.node") as NativeAddon;
} catch (err) {
	loadError = (err as Error).message;
}

/** AXError 取值见 SDK 的 AXError.h；别凭记忆写，-25204 和 -25211 很容易搞混。 */
const AX_ERRORS: Record<number, string> = {
	[-1]: "未执行（上游步骤已失败）",
	[-25200]: "调用失败",
	[-25201]: "参数非法",
	[-25202]: "元素已失效",
	[-25204]: "无法完成（通常是调用方没有「辅助功能」权限）",
	[-25205]: "当前元素不支持该属性",
	[-25206]: "当前元素不支持该操作",
	[-25208]: "当前应用未实现该属性",
	[-25211]: "辅助功能 API 被禁用（没有「辅助功能」权限）",
	[-25212]: "没有值（当前没有焦点元素，或没有选中内容）",
	[-25213]: "当前元素不支持该参数化属性",
};

function explain(code: number): string {
	return AX_ERRORS[code] ?? `AX 错误 ${code}`;
}

export interface SelectionReading {
	/** 选中的文字，读不到时为空串 */
	text: string;
	/** 人话版探测报告，写日志和弹窗都用它 */
	report: string;
}

function formatReport(result: Probe, text: string): string {
	const appSource = result.usedFallback ? "（已退回按前台 pid 取应用）" : "";
	const stolen = result.frontPid === result.selfPid ? " ← 是本应用自己，焦点被抢走了" : "";
	const lastOther =
		result.lastOtherPid > 0 && result.lastOtherPid !== result.frontPid
			? `\n上一个前台应用：pid=${result.lastOtherPid}`
			: "";
	const element = result.elementErr === 0
		? `成功（${result.axRole || "未知角色"}）`
		: `${explain(result.elementErr)}${result.usedFallback ? `，轮询 ${result.elementAttempts} 次仍未拿到` : ""}`;
	return [
		`选中文字：${text ? `${text.length} 个字符` : "（空）"}`,
		`读选区：${result.selectErr === 0 ? "成功" : explain(result.selectErr)}`,
		`读焦点元素：${element}`,
		`读焦点应用：${result.appErr === 0 ? "成功" : explain(result.appErr)}${appSource}`,
		`AX 焦点应用：pid=${result.axAppPid} ${result.axAppName}`,
		`系统前台应用：pid=${result.frontPid} ${result.frontName}${stolen}${lastOther}`,
	].join("\n");
}

/** 读一次选区，同时给出文字和完整报告。同步调用，不 spawn 子进程。 */
export function inspectSelection(): SelectionReading {
	if (!addon) {
		return { text: "", report: `原生扩展未加载，读选区不可用：${loadError || "未知原因"}` };
	}
	try {
		const result = addon.readFocusedSelection();
		const text = (result.text ?? "").trim();
		return { text, report: formatReport(result, text) };
	} catch (err) {
		return { text: "", report: `原生扩展调用失败：${(err as Error).message}` };
	}
}

/** 给设置菜单用的诊断信息。 */
export function describeSelectionAccess(): string {
	return inspectSelection().report;
}
