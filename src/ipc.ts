import { ipcMain, shell } from "electron";
import { mergeConfig, loadConfig, type Config, type ConfigPatch } from "./config.js";
import { CH, guard } from "./contract.js";
import { listModels } from "./deepseek.js";
import { applyLaunchAtLogin, isLaunchAtLoginAvailable } from "./login-item.js";
import { safeExternalUrl } from "./markdown.js";

/** config:load 的返回：整个配置，外加一个「开机自启能不能生效」的标记（开发模式下不能）。 */
export interface ConfigView extends Config {
	canLaunchAtLogin: boolean;
}

/**
 * 要碰应用状态（历史、浮窗、正在跑的请求）的几个动作，由 main 提供。
 * 其余纯转发的 handler 就地实现，不必绕一圈。
 */
export interface IpcActions {
	/** 翻页，delta 已经归一成 ±1 */
	page(delta: number): void;
	/** 用户点了「待发送」的内容框 */
	send(): void;
	remove(): void;
	copy(): void;
	close(): void;
	closeSettings(): void;
}

export function registerIpc(actions: IpcActions): void {
	ipcMain.handle(CH.configLoad, () => guard((): ConfigView => ({ ...loadConfig(), canLaunchAtLogin: isLaunchAtLoginAvailable() })));
	ipcMain.handle(CH.configSave, (_event, patch: ConfigPatch) =>
		guard(() => {
			const next = mergeConfig(patch);
			// 保存后立刻生效，不用等下次启动
			applyLaunchAtLogin(next.launchAtLogin);
			return next;
		}),
	);
	ipcMain.handle(CH.modelsList, (_event, apiKey: string) => guard(() => listModels(apiKey)));

	ipcMain.on(CH.page, (_event, delta: number) => actions.page(delta > 0 ? 1 : -1));
	ipcMain.on(CH.send, () => actions.send());
	ipcMain.on(CH.remove, () => actions.remove());
	ipcMain.on(CH.copy, () => actions.copy());
	ipcMain.on(CH.close, () => actions.close());
	ipcMain.on(CH.settingsClose, () => actions.closeSettings());
	ipcMain.on(CH.openExternal, (_event, url: string) => {
		// 只放行 http/https，别让渲染出来的内容拿自定义 scheme 去拉起别的应用
		const safe = safeExternalUrl(url);
		if (safe) void shell.openExternal(safe);
	});
}
