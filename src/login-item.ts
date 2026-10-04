import { app } from "electron";

/**
 * 开关开机自启（macOS 的「登录项」）。
 *
 * **只在打包后真正注册。** 开发模式跑的是 node_modules 里那个 Electron.app，
 * 把它注册成登录项，开机拉起来的是没有应用的裸 Electron（一个空白窗口），不是 What's This?。
 * macOS 也没给「未打包 + 带参数启动」留口子 —— setLoginItemSettings 的 path/args 只在 Windows 上管用。
 * 与其在你机器上注册一个坏掉的登录项，不如什么都不做，并在设置窗口里说明。
 */
export function applyLaunchAtLogin(enabled: boolean): void {
	if (!app.isPackaged) return;
	app.setLoginItemSettings({ openAtLogin: enabled });
}

/** 开机自启是否真的能生效。设置窗口用它决定要不要提示「开发模式下不生效」。 */
export function isLaunchAtLoginAvailable(): boolean {
	return app.isPackaged;
}
