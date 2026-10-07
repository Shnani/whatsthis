// 打包成 .app 再压成 .dmg，产物落在 release/。
//
// 只出 arm64：原生扩展 build/ax.node 是 clang 按宿主架构编的，出通用包得把
// native/ax.m 编成 universal（-arch arm64 -arch x86_64），这版先不做。
//
// dmg 用系统自带的 hdiutil 做，不引第三方打包器：一个中转目录里放 .app 和
// 指向 /Applications 的软链，压出来就是「拖进去」的常规安装体验。
import { packager } from "@electron/packager";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "release");
const NAME = "whatsthis";
const BUNDLE_ID = "com.shnani.whatsthis";
const ARCH = "arm64";
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));

console.log(`[dist] 打包 ${NAME} ${version} (darwin-${ARCH})`);

// 不用 asar：应用运行时靠 app.getAppPath() 直接读 src/*.html 和 assets/*.png，
// 还要 require build/ax.node。打进归档就得依赖 Electron 的 fs 补丁和自动 unpack，
// 多一层隐性故障点，而归档对这个应用没有收益。
const packagerOpts = {
	dir: ROOT,
	name: NAME,
	platform: "darwin",
	arch: ARCH,
	appBundleId: BUNDLE_ID,
	appVersion: version,
	asar: false,
	out: OUT,
	overwrite: true,
	// 把 devDependencies 从产物里的 node_modules 剔掉
	prune: true,
	ignore: [
		/^\/release($|\/)/,
		/^\/test($|\/)/,
		/^\/scripts($|\/)/,
		/^\/\.claude($|\/)/,
		/^\/\.git($|\/)/,
		/^\/\.git$/,
		/^\/\.env/,
		/^\/\.gitignore$/,
	],
};

const [appPath] = await packager(packagerOpts);
const appDir = appPath.endsWith(".app") ? appPath : path.join(appPath, `${NAME}.app`);

console.log(`[dist] .app -> ${path.relative(ROOT, appDir)}`);

// 运行时要靠 app.getAppPath() 找到这几样，少一个功能就静默失效，所以打包后必检
const mustExist = ["dist/main.js", "dist/preload.mjs", "src/panel.html", "src/settings.html", "assets/trayTemplate.png", "build/ax.node"];
const missing = mustExist.filter((rel) => !fs.existsSync(path.join(appDir, "Contents", "Resources", "app", rel)));
if (missing.length > 0) throw new Error(`产物缺文件：${missing.join(", ")}`);

/**
 * pi-ai 把六家厂商的 SDK 全声明成依赖，但它在 dist/providers/*.js 里是按 api 名
 * 动态 import 的，只有真正用到的那一个会被加载 —— 本应用只走 openai-completions
 * （见 src/agent.ts 的 resolveModel），其余模块和它们的 SDK 永远不会被 import。
 *
 * 代价：以后要多支持一家厂商，得把对应的包从 UNUSED_PROVIDERS 移出去，否则应用
 * 能装、能启动、能出图标，一到提问才报模块找不到。
 *
 * 必须在签名之前调用：签完再动 bundle 里的文件，签名就失效了。
 */
const UNUSED_PROVIDERS = [
	"@anthropic-ai", // providers/anthropic.js
	"@google", // providers/google.js、google-vertex.js
	"@mistralai", // providers/mistral.js
	"@aws-sdk", // providers/amazon-bedrock.js
	"@smithy", //    ↑ 的传递依赖
];

function mb(dir) {
	return Number(execFileSync("du", ["-sk", dir], { encoding: "utf-8" }).split("\t")[0]) / 1024;
}

function pruneUnusedProviders(appDir) {
	const appResources = path.join(appDir, "Contents", "Resources", "app");
	const nm = path.join(appResources, "node_modules");
	const before = mb(nm);

	for (const pkg of UNUSED_PROVIDERS) fs.rmSync(path.join(nm, pkg), { recursive: true, force: true });

	// 删掉的包会把一批传递依赖留成孤儿。让 npm 重建这棵树，把不再被任何包依赖的
	// （extraneous）一并清掉，免得手工维护一份迟早会过时的名单。
	// npm ls 遇到缺失依赖会以非零码退出，但 JSON 照样写在 stdout 上。
	let json;
	try {
		json = execFileSync("npm", ["ls", "--omit=dev", "--all", "--json"], {
			cwd: appResources,
			encoding: "utf-8",
			maxBuffer: 1 << 28,
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch (err) {
		json = err.stdout;
	}
	const extraneous = new Set();
	(function walk(node) {
		for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
			if (dep.extraneous) extraneous.add(name);
			walk(dep);
		}
	})(JSON.parse(json));

	let orphans = 0;
	for (const name of extraneous) {
		const dir = path.join(nm, name);
		if (fs.existsSync(dir)) {
			fs.rmSync(dir, { recursive: true, force: true });
			orphans++;
		}
	}
	console.log(
		`[dist] node_modules ${before.toFixed(0)}MB -> ${mb(nm).toFixed(0)}MB` +
			`（去掉 ${UNUSED_PROVIDERS.length} 个厂商 SDK + ${orphans} 个孤儿依赖）`,
	);
}

pruneUnusedProviders(appDir);

// 打包器给的 ad-hoc 签名沿用 Electron 自身的 identifier（"Electron"），系统据此
// 认应用，辅助功能列表里就不是 whatsthis。重新 ad-hoc 签一次把 identifier 拨正。
// 没有 Developer ID，所以只能 ad-hoc，应用仍会被 Gatekeeper 拦首次启动。
execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--identifier", BUNDLE_ID, appDir], { stdio: "inherit" });
execFileSync("codesign", ["--verify", "--deep", "--strict", appDir], { stdio: "inherit" });
const { stderr } = spawnSync("codesign", ["-dv", appDir], { encoding: "utf-8" });
const ident = stderr.split("\n").find((l) => l.startsWith("Identifier="));
if (!ident?.includes(BUNDLE_ID)) throw new Error(`签名 identifier 不对：${ident}`);
console.log(`[dist] ${ident}`);

// 中转目录：.app + /Applications 软链
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "whatsthis-dmg-"));
try {
	fs.cpSync(appDir, path.join(stage, `${NAME}.app`), { recursive: true });
	fs.symlinkSync("/Applications", path.join(stage, "Applications"));

	const dmg = path.join(OUT, `${NAME}-${version}-${ARCH}.dmg`);
	fs.rmSync(dmg, { force: true });
	execFileSync("hdiutil", ["create", "-volname", NAME, "-srcfolder", stage, "-ov", "-format", "UDZO", dmg], {
		stdio: "inherit",
	});

	const mb = (fs.statSync(dmg).size / 1024 / 1024).toFixed(1);
	console.log(`[dist] 完成 -> ${path.relative(ROOT, dmg)} (${mb} MB)`);
} finally {
	fs.rmSync(stage, { recursive: true, force: true });
}
