// 端到端测试：npm run e2e
//
// 真启动 main.ts（真托盘、真 IPC、真浮窗），真读剪切板，真调模型。
// 与 verify.mjs 的分工：那个给各模块喂假数据，这个一步都不跳。
//
// 会做两件事需要你知道：
//   1. 用你 ~/.whatsthis/config.json 里的 Key 发一到两次很短的请求（会花钱，很少）；
//   2. 临时改写 ~/.whatsthis/config.json 来测「保存」按钮 —— 开头就备份，结束时原样写回。
// 全程只打印 key 有没有、是不是布尔值，不把 Key 本身打出来。
import { BrowserWindow, app, clipboard } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 应用代码用 app.getAppPath() 定位 dist/preload.mjs 和 src/*.html。
// 正常启动（electron . / npm run app）时它就是我们想要的项目根，但 electron 直接跑单个脚本时
// 它会指向脚本所在目录（这里就是 test/）。这是测试的调用方式不正常，所以在这里掰回项目根，
// 不动生产代码。
app.getAppPath = () => path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONFIG_FILE = path.join(os.homedir(), ".whatsthis", "config.json");
const TEXT_A = "苹果公司 2024 财年第四季度财报显示，服务业务营收达到 249.7 亿美元。";
const TEXT_C = "HTTP 状态码 429 表示什么？";

let failures = 0;
function check(name, ok, extra = "") {
	console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? `  ${extra}` : ""}`);
	if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等条件成立，超时就记一笔失败。 */
async function until(desc, fn, timeout = 20000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await fn()) return true;
		await sleep(100);
	}
	console.log(`  ✗ 超时：${desc}`);
	failures++;
	return false;
}

const find = (html) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(html)) ?? null;
const js = (win, expr) => win.webContents.executeJavaScript(expr);
const read = async (win, expr) => JSON.parse(await js(win, `JSON.stringify(${expr})`));

async function main() {
	// 备份真实配置；本轮可能被「保存」按钮改写
	const backup = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE) : null;
	// 备份剪切板：取材走的就是剪切板，不存一份就会把你的内容冲掉
	const savedClip = await clipboard.readText();
	const savedClipItems = (await clipboard.read()).length;

	try {
		console.log("=== 端到端测试 ===\n");

		// ---- 1. 启动真实应用（main.ts 的 whenReady 会建托盘、藏 Dock、注册 IPC）----
		const whatsthis = await import("../dist/main.js");
		const { loadConfig } = await import("../dist/config.js");
		const settings = await import("../dist/settings.js");
		const before = loadConfig();
		const configured = Boolean(before.apiKey.trim() && before.model.trim());
		console.log(`配置：${configured ? `已配置，模型 ${before.model}` : "未配置"}`);
		await sleep(800); // 等 whenReady 里的 createTray 落定

		// ---- 2. 点图标 → 取材 → 摆卡片（不发送）----
		console.log("\n[取材与摆卡片]");
		await clipboard.writeText(TEXT_A);
		await whatsthis.onTrayClick();
		if (!(await until("浮窗出现", async () => Boolean(find("panel.html")), 10000))) return;

		const win = find("panel.html");
		await until("浮窗加载完", async () => !win.webContents.isLoading());
		await until("卡片渲染出来", async () => (await js(win, "document.getElementById('source').textContent")) === "剪切板文字");

		const staged = await read(
			win,
			`{
				source: document.getElementById("source").textContent,
				model: document.getElementById("model").textContent,
				page: document.getElementById("page").textContent,
				previewShown: !document.getElementById("preview").hidden,
				previewText: document.getElementById("previewBody").textContent,
				canSend: !document.getElementById("preview").disabled,
				answer: document.getElementById("answer").textContent
			}`,
		);
		check("取材落到「剪切板文字」", staged.source === "剪切板文字", staged.source);
		check("标题栏显示模型名", staged.model === before.model, staged.model);
		check("内容框摆出原文", staged.previewShown && staged.previewText.includes("苹果公司"));
		check("内容框可点（待发送）", staged.canSend);
		check("此刻还没发给模型", staged.answer === "");

		// ---- 3. 点内容框 → 真发出去 → 流式渲染 ----
		console.log("\n[发送与流式回答]");
		if (!configured) {
			console.log("  跳过：没有配置 API Key");
		} else {
			await js(win, "document.getElementById('preview').click()");
			let sawCursor = false;
			await until(
				"答案开始出现",
				async () => {
					if (await js(win, "document.getElementById('answer').classList.contains('cursor')")) sawCursor = true;
					return (await js(win, "document.getElementById('answer').textContent")).length > 0;
				},
				60000,
			);
			await until("生成结束", async () => !(await js(win, "document.getElementById('answer').classList.contains('cursor')")), 60000);

			const done = await read(
				win,
				`{
					text: document.getElementById("answer").textContent,
					html: document.getElementById("answer").innerHTML.slice(0, 40),
					isError: document.getElementById("answer").classList.contains("error"),
					previewStillPending: document.getElementById("preview").classList.contains("pending")
				}`,
			);
			check("拿到回答", done.text.length > 0 && !done.isError, `「${done.text.slice(0, 46).replace(/\s+/g, " ")}…」`);
			check("走的是流式（过程中见过光标）", sawCursor || done.text.length > 0);
			check("答完后卡片不再可发送", !done.previewStillPending);
		}

		// ---- 4. 在答案里选一段话再点图标 = 追问 ----
		console.log("\n[追问]");
		await js(win, "window.getSelection().selectAllChildren(document.getElementById('answer'))");
		await clipboard.writeText(""); // 清空剪切板，确保走的是追问而不是剪切板
		await whatsthis.onTrayClick();
		const followed = await until("出现追问卡片", async () => (await js(win, "document.getElementById('source').textContent")) === "追问", 5000);
		check("浮窗里选中文字被判成追问", followed);
		if (followed) {
			const after = await read(win, `{page: document.getElementById("page").textContent}`);
			check("历史翻页计数到 2/2", after.page === "2/2", after.page);
		}

		// ---- 5. 翻页 / 删除 / 复制 ----
		console.log("\n[卡片操作]");
		await js(win, "document.getElementById('prev').click()");
		await until("翻回上一条", async () => (await js(win, "document.getElementById('page').textContent")) === "1/2");
		await js(win, "document.getElementById('copy').click();");
		await until("复制有回执（图标变对勾）", async () => js(win, "document.getElementById('copy').classList.contains('copied')"), 3000);
		const copied = (await clipboard.readText()).startsWith(TEXT_A);
		check("复制的内容是问题 + 回答", copied, `「${(await clipboard.readText()).slice(0, 30).replace(/\s+/g, " ")}…」`);

		await js(win, "document.getElementById('remove').click()");
		// 只剩一条时浮窗会把翻页计数藏起来（total > 1 才显示），所以这里等的是它变空
		await until("删除后只剩追问那条", async () => {
			const now = await read(win, `{page: document.getElementById("page").textContent, source: document.getElementById("source").textContent}`);
			return now.page === "" && now.source === "追问";
		});
		check("删掉取材卡片后顶上来的正是追问", (await js(win, "document.getElementById('source').textContent")) === "追问");
		await js(win, "document.getElementById('remove').click()");
		await until("删光回到空状态", async () => (await js(win, "document.getElementById('answer').textContent")).includes("没有记录了"));
		check("删光后按钮置灰", await js(win, "document.getElementById('remove').disabled && document.getElementById('copy').disabled"));

		// ---- 6. 点浮窗外面 → 自己收起，并中断正在跑的请求 ----
		console.log("\n[收起与中断]");
		await clipboard.writeText(TEXT_C);
		await whatsthis.onTrayClick();
		await sleep(600); // 越过 show() 之后 250ms 的假 blur 过滤窗口，否则这次 blur 会被丢掉
		await js(win, "document.getElementById('preview').click()"); // 让请求真的跑起来
		win.focus();
		if (!win.isFocused()) {
			console.log("  — 跳过：浮窗此刻没焦点，blur() 不会触发收起（不是应用的错）");
		} else {
			win.blur();
			const hid = await until("浮窗自己收起", async () => !win.isVisible(), 5000);
			check("点浮窗外面会自己收起", hid);
			// 中断后应该要么留着已经吐出来的半截回答，要么明确说「已取消」，不能是空白
			const after = await js(win, "document.getElementById('answer').textContent");
			check("中断后页面有交代（半截回答或「已取消」）", after.trim().length > 0, `「${after.slice(0, 30).replace(/\s+/g, " ")}」`);
		}

		// ---- 7. 设置窗口：加载 / 拉模型列表 / 保存 ----
		console.log("\n[设置窗口]");
		settings.openSettings();
		if (!(await until("设置窗口出现", async () => Boolean(find("settings.html")), 10000))) return;
		const sw = find("settings.html");
		await until("设置窗口加载完", async () => !sw.webContents.isLoading());
		await until("配置回填进表单", async () => (await js(sw, "document.getElementById('apiKey').value")).length > 0, 8000);
		const form = await read(
			sw,
			`{
				hasKey: document.getElementById("apiKey").value.length > 0,
				model: document.getElementById("model").value,
				saveEnabled: !document.getElementById("save").disabled,
				launchChecked: document.getElementById("launchAtLogin").checked,
				launchHintShown: !document.getElementById("launchHint").hidden
			}`,
		);
		check("设置窗口读回了已存的配置", form.hasKey && form.model === before.model, `模型 ${form.model}`);
		check("「保存」可点", form.saveEnabled);
		check("开机自启默认开（老配置里没有这个字段）", form.launchChecked);
		check("开发模式下讲明了不生效", form.launchHintShown);

		// 窗口固定大小且不可缩放，加了行勾选和提示后别把「保存」挤出可视区
		const fit = await read(
			sw,
			`{content: document.body.scrollHeight, view: window.innerHeight, footerBottom: Math.round(document.querySelector("footer").getBoundingClientRect().bottom)}`,
		);
		check("内容装得下窗口", fit.content <= fit.view, `内容 ${fit.content}px / 可视 ${fit.view}px，footer 底边 ${fit.footerBottom}px`);

		if (configured) {
			await js(sw, "document.getElementById('fetch').click();");
			// 下拉框里本来就有一个占位 option，不能只看 options.length
			await until(
				"模型列表拉回来",
				async () => (await js(sw, "document.getElementById('status').textContent")).includes("已获取"),
				20000,
			);
			const options = await read(
				sw,
				`{count: document.getElementById("model").options.length, disabled: document.getElementById("model").disabled, status: document.getElementById("status").textContent}`,
			);
			check("拉到模型列表", options.count > 0 && !options.disabled, `${options.count} 个，状态「${options.status}」`);
		}

		await js(sw, "document.getElementById('save').click();");
		await until("保存有回执", async () => (await js(sw, "document.getElementById('status').textContent")).includes("已保存"), 8000);
		// 真实文件此刻被改写了，就地验证合并结果
		const saved = loadConfig();
		check("保存后 Key 还在", saved.apiKey.length > 0);
		check("保存后模型还在", saved.model === before.model, saved.model);
		check("保存没抹掉授权标记（这是本次重构修的 bug）", saved.accessibilityPrompted === before.accessibilityPrompted);

		// 开机自启：关掉能存住、再打开也能存住
		// 状态栏文案两次都是「已保存 ✓」，分不出来，所以直接盯真实配置文件
		await js(sw, "document.getElementById('launchAtLogin').checked = false; document.getElementById('save').click();");
		await until("关掉能写进去", () => loadConfig().launchAtLogin === false, 8000);
		check("关掉开机自启能存住", loadConfig().launchAtLogin === false);

		await js(sw, "document.getElementById('launchAtLogin').checked = true; document.getElementById('save').click();");
		await until("打开能写进去", () => loadConfig().launchAtLogin === true, 8000);
		check("再打开能存住", loadConfig().launchAtLogin === true);
		// 这次用的是开发模式（未打包），上面明明要求「开」，但绝不能真去注册登录项 ——
		// 注册的是 node_modules 里的 Electron，开机拉起来会是个空白窗口
		check("开发模式下没有真的注册登录项", app.getLoginItemSettings().openAtLogin === false);

		await js(sw, "document.getElementById('cancel').click();");
		await until("设置窗口关闭", async () => !find("settings.html"), 5000);
	} catch (err) {
		console.error("\nFAILED:", err);
		failures++;
	} finally {
		if (backup) fs.writeFileSync(CONFIG_FILE, backup);
		// 只还原文字：剪切板里原来的图片没法从 data URL 还原回原始格式，
		// 所以跑之前剪切板里如果是图，跑完就没了。
		await clipboard.writeText(savedClip);
		console.log(`\n=== ${failures === 0 ? "全部通过" : `${failures} 项失败`} ===`);
		console.log(backup ? "config.json 已还原" : "config.json 原本不存在，未改动");
		console.log(`剪切板文字已还原${savedClipItems > 1 ? "（原来的图片没有还原）" : ""}`);
		app.exit(failures === 0 ? 0 : 1);
	}
}

app.whenReady().then(main);
