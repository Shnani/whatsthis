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
