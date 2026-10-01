import { contextBridge, ipcRenderer } from "electron";
import type { ConfigPatch } from "./config.js";
import { CH, type AnswerChunk } from "./contract.js";
import type { EntryView } from "./history.js";

function on<T>(channel: string, cb: (payload: T) => void): () => void {
	const listener = (_event: unknown, payload: T) => cb(payload);
	ipcRenderer.on(channel, listener);
	return () => ipcRenderer.off(channel, listener);
}

contextBridge.exposeInMainWorld("whatsthis", {
	// 结果浮窗。entry 为 null 表示一条记录都没有了（空状态）
	onEntry: (cb: (entry: EntryView | null) => void) => on(CH.entry, cb),
	onHtml: (cb: (chunk: AnswerChunk) => void) => on(CH.html, cb),
	onNotice: (cb: (message: string) => void) => on(CH.notice, cb),
	page: (delta: number) => ipcRenderer.send(CH.page, delta),
	remove: () => ipcRenderer.send(CH.remove),
	copy: () => ipcRenderer.send(CH.copy),
	// 点内容框：把这一条发给模型。在此之前内容只在本机
	send: () => ipcRenderer.send(CH.send),
	cancel: () => ipcRenderer.send(CH.cancel),
	closePanel: () => ipcRenderer.send(CH.close),
	openExternal: (url: string) => ipcRenderer.send(CH.openExternal, url),

	// 设置窗口
	loadConfig: () => ipcRenderer.invoke(CH.configLoad),
	saveConfig: (patch: ConfigPatch) => ipcRenderer.invoke(CH.configSave, patch),
	listModels: (apiKey: string) => ipcRenderer.invoke(CH.modelsList, apiKey),
	closeSettings: () => ipcRenderer.send(CH.settingsClose),
});
