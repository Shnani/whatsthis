import { contextBridge, ipcRenderer } from "electron";
import type { EntryView } from "./history.js";

/** 流式输出期间推进来的片段，只更新对应那条记录。 */
export interface AnswerChunk {
	id: number;
	html: string;
}

function on<T>(channel: string, cb: (payload: T) => void): () => void {
	const listener = (_event: unknown, payload: T) => cb(payload);
	ipcRenderer.on(channel, listener);
	return () => ipcRenderer.off(channel, listener);
}

contextBridge.exposeInMainWorld("whatsthis", {
	// 结果浮窗。entry 为 null 表示一条记录都没有了（空状态）
	onEntry: (cb: (entry: EntryView | null) => void) => on("panel:entry", cb),
	onHtml: (cb: (chunk: AnswerChunk) => void) => on("panel:html", cb),
	onNotice: (cb: (message: string) => void) => on("panel:notice", cb),
	page: (delta: number) => ipcRenderer.send("panel:page", delta),
	remove: () => ipcRenderer.send("panel:delete"),
	copy: () => ipcRenderer.send("panel:copy"),
	// 点内容框：把这一条发给模型。在此之前内容只在本机
	send: () => ipcRenderer.send("panel:send"),
	cancel: () => ipcRenderer.send("panel:cancel"),
	closePanel: () => ipcRenderer.send("panel:close"),
	openExternal: (url: string) => ipcRenderer.send("open-external", url),

	// 设置窗口
	loadConfig: () => ipcRenderer.invoke("config:load"),
	saveConfig: (config: { apiKey: string; model: string }) => ipcRenderer.invoke("config:save", config),
	listModels: (apiKey: string) => ipcRenderer.invoke("models:list", apiKey),
	closeSettings: () => ipcRenderer.send("settings:close"),
});
