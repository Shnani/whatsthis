import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
	apiKey: string;
	model: string;
	/** 是否已经主动请求过一次「辅助功能」权限，避免每次启动都弹窗 */
	accessibilityPrompted: boolean;
}

const DIR = path.join(os.homedir(), ".whatsthis");
const FILE = path.join(DIR, "config.json");
const EMPTY: Config = { apiKey: "", model: "", accessibilityPrompted: false };

/** 读取配置。文件不存在时返回空配置，其他 IO 错误向上抛。 */
export function loadConfig(): Config {
	let raw: string;
	try {
		raw = fs.readFileSync(FILE, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY };
		throw new Error(`读取配置失败（${FILE}）：${(err as Error).message}`);
	}
	try {
		const parsed = JSON.parse(raw) as Partial<Config>;
		return {
			apiKey: parsed.apiKey ?? "",
			model: parsed.model ?? "",
			accessibilityPrompted: parsed.accessibilityPrompted ?? false,
		};
	} catch (err) {
		throw new Error(`配置文件格式错误（${FILE}）：${(err as Error).message}`);
	}
}

/** 写入配置。失败时抛出，绝不静默吞掉。 */
export function saveConfig(config: Config): void {
	try {
		fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
		fs.writeFileSync(FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
	} catch (err) {
		throw new Error(`保存配置失败（${FILE}）：${(err as Error).message}`);
	}
}

/** 设置窗口能改的字段。其余字段不归它管，别让它覆盖掉。 */
export type ConfigPatch = Pick<Config, "apiKey" | "model">;

/**
 * 保存设置窗口改的那两项，其余字段从旧配置带过来。
 *
 * 早先是把渲染进程发来的对象直接落盘，结果 accessibilityPrompted 每次保存都被抹掉，
 * 下次启动又弹一次辅助功能授权。
 */
export function mergeConfig(patch: ConfigPatch): Config {
	let base: Config;
	try {
		base = loadConfig();
	} catch {
		// 配置文件读不出来（坏了）：这次保存就当成从头写一份，别让用户卡在「存不下去」
		base = { ...EMPTY };
	}
	const next = { ...base, ...patch };
	saveConfig(next);
	return next;
}
