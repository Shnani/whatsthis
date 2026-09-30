// 编译 native/ax.m 成 build/ax.node。
// N-API 是 ABI 稳定的，所以用 node 的头文件编出来的扩展在 Electron 里也能直接加载，
// 不需要 electron-rebuild 或 node-gyp。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "build");
const OUT = path.join(OUT_DIR, "ax.node");

// homebrew / nvm 的布局都是 <node 可执行文件目录>/../include/node
const INCLUDE = path.resolve(path.dirname(process.execPath), "..", "include", "node");

if (!existsSync(path.join(INCLUDE, "node_api.h"))) {
	console.warn(`[native] 找不到 node_api.h（${INCLUDE}），跳过编译 —— 读选区功能将不可用`);
	process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });

try {
	execFileSync(
		"clang",
		[
			"-bundle",
			"-undefined",
			"dynamic_lookup",
			"-fobjc-arc",
			"-O2",
			"-o",
			OUT,
			path.join(ROOT, "native", "ax.m"),
			`-I${INCLUDE}`,
			"-framework",
			"AppKit",
			"-framework",
			"ApplicationServices",
			"-framework",
			"Foundation",
		],
		{ stdio: "inherit" },
	);
	console.log(`[native] 已编译 ${path.relative(ROOT, OUT)}`);
} catch (err) {
	// 编译失败不该挡住整个构建：读选区不可用，其余功能照常
	console.warn(`[native] 编译失败，读选区功能将不可用：${err.message}`);
}
