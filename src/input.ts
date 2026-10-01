import type { ImageContent } from "@mariozechner/pi-ai";
import { systemPreferences } from "electron";
import { readClipboard } from "./clipboard.js";
import { selection as panelSelection } from "./panel.js";
import { inspectSelection } from "./selection.js";

export type Input =
	| { kind: "followup"; text: string }
	| { kind: "selection"; text: string }
	| { kind: "image"; image: ImageContent; dataUrl: string }
	| { kind: "text"; text: string }
	| { kind: "empty" };

export interface Gathered {
	input: Input;
	/** 人话版取材经过，写进 last-click.log：出问题时靠它认出是哪一环断的。 */
	report: string;
}

/** 取材优先级：浮窗里选中的内容（追问）→ 鼠标选区 → 剪切板图片 → 剪切板文字。 */
export async function gatherInput(): Promise<Gathered> {
	let report: string;
	let input: Input;

	const asked = await panelSelection();
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

	return { input, report };
}

/** 去重键：同一个问题连着问两次只留最近一条。 */
export function keyOf(input: Exclude<Input, { kind: "empty" }>): string {
	if (input.kind === "image") return input.dataUrl;
	return `${input.kind === "followup" ? "追问" : "取材"}:${input.text}`;
}
