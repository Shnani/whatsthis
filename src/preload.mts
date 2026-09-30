import { contextBridge, ipcRenderer } from "electron";

/** 结果浮窗收到的一次提问请求。 */
export interface AnswerStart {
	kind: "selection" | "text" | "image" | "empty";
	model: string;
	text?: string;
	dataUrl?: string;
}

function on<T>(channel: string, cb: (payload: T) => void): () => void {
	const listener = (_event: unknown, payload: T) => cb(payload);
	ipcRenderer.on(channel, listener);
	return () => ipcRenderer.off(channel, listener);
}

contextBridge.exposeInMainWorld("whatsthis", {
	// 结果浮窗
	onStart: (cb: (payload: AnswerStart) => void) => on("answer:start", cb),
	onHtml: (cb: (html: string) => void) => on("answer:html", cb),
	onDone: (cb: () => void) => on("answer:done", cb),
	onError: (cb: (message: string) => void) => on("answer:error", cb),
	cancel: () => ipcRenderer.send("answer:cancel"),
	closePanel: () => ipcRenderer.send("panel:close"),
	openExternal: (url: string) => ipcRenderer.send("open-external", url),

	// 设置窗口
	loadConfig: () => ipcRenderer.invoke("config:load"),
	saveConfig: (config: { apiKey: string; model: string }) => ipcRenderer.invoke("config:save", config),
	listModels: (apiKey: string) => ipcRenderer.invoke("models:list", apiKey),
	closeSettings: () => ipcRenderer.send("settings:close"),
});
