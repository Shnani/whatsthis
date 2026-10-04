/**
 * 主进程 ↔ 渲染进程的契约：channel 名字、消息类型、IPC 返回包装。
 *
 * 这里**不许 import electron**：preload 跑在渲染进程侧，把 ipcMain 之类的主进程
 * 模块拉进来会在加载时炸掉。所以只放纯类型和常量，两边都从这里引。
 */

/** 消息通道名。以前是散在各处的字符串字面量，改一个漏一个。 */
export const CH = {
	// 浮窗 ← 主进程
	entry: "panel:entry",
	html: "panel:html",
	notice: "panel:notice",
	// 浮窗 → 主进程
	page: "panel:page",
	send: "panel:send",
	remove: "panel:delete",
	copy: "panel:copy",
	close: "panel:close",
	// 设置窗口
	configLoad: "config:load",
	configSave: "config:save",
	modelsList: "models:list",
	settingsClose: "settings:close",
	// 两个页面都用
	openExternal: "open-external",
} as const;

/** 流式输出期间推进来的片段，只更新对应那条记录。 */
export interface AnswerChunk {
	id: number;
	html: string;
}

/** IPC 统一返回 { ok, ... }，避免 Electron 把异常消息包成 "Error invoking remote method"。 */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export function guard<T>(fn: () => T | Promise<T>): Promise<Result<T>> {
	return Promise.resolve()
		.then(fn)
		.then((value) => ({ ok: true, value }) as const)
		.catch((err: unknown) => ({ ok: false, error: (err as Error).message }) as const);
}
