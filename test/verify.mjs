// 冒烟测试：npm run verify
// 1) 用 Electron 44 的新异步 clipboard API 走一遍 src/main.ts 里的读取逻辑
// 2) 驱动 panel.html，确认 preload 通道和 DOM 更新正常
// 注意：会临时改写系统剪切板，结束时恢复原文字（原来的图片不会还原）。
import { ClipboardItem, app, BrowserWindow, clipboard, ipcMain, nativeImage } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_IMAGE_EDGE = 2048;
const PNG_1PX =
	"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";

/** 与 src/main.ts 的 readClipboard 保持一致 */
async function readClipboard() {
	const text = (await clipboard.readText()).trim();
	for (const item of await clipboard.read()) {
		const imageType = item.types.find((t) => t.startsWith("image/"));
		if (!imageType) continue;
		const blob = await item.getType(imageType);
		let image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
		if (image.isEmpty()) continue;
		const { width, height } = image.getSize();
		const longest = Math.max(width, height);
		if (longest > MAX_IMAGE_EDGE) {
			const scale = MAX_IMAGE_EDGE / longest;
			image = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) });
		}
		return { kind: "image", size: image.getSize(), base64Len: image.toPNG().toString("base64").length };
	}
	return { kind: "text", text };
}

async function main() {
	const saved = await clipboard.readText();
	const savedImage = clipboard.read(); // 仅用于长度判断，下面不还原图片

	try {
		// --- 1. 文本分支 ---
		await clipboard.writeText("hello from verify");
		console.log("text   ->", JSON.stringify(await readClipboard()));

		// --- 2. 图片分支（新 API 写入一块 PNG） ---
		const buf = nativeImage.createFromBuffer(Buffer.from(PNG_1PX, "base64")).toPNG();
		await clipboard.write([new ClipboardItem({ "image/png": new Blob([buf], { type: "image/png" }) })]);
		console.log("image  ->", JSON.stringify(await readClipboard()));

		// --- 3. 渲染进程 wiring ---
		const win = new BrowserWindow({
			show: false,
			webPreferences: {
				preload: path.join(ROOT, "dist", "preload.mjs"),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: false,
			},
		});
		await win.loadFile(path.join(ROOT, "src", "panel.html"));

		const api = (expr) => win.webContents.executeJavaScript(expr);
		console.log("bridge ->", await api("typeof window.whatsthis"));

		const entry = (over) => ({
			id: 1,
			index: 2,
			total: 3,
			kind: "image",
			model: "deepseek-v4-flash",
			html: "",
			status: "running",
			dataUrl: `data:image/png;base64,${buf.toString("base64")}`,
			...over,
		});
		const shown = () =>
			api(
				"JSON.stringify({model:document.getElementById('model').textContent,source:document.getElementById('source').textContent,page:document.getElementById('page').textContent,prevOff:document.getElementById('prev').disabled,nextOff:document.getElementById('next').disabled,answer:document.getElementById('answer').textContent,bold:!!document.querySelector('#answer strong'),cursor:document.getElementById('answer').classList.contains('cursor'),isError:document.getElementById('answer').classList.contains('error'),img:document.querySelector('#preview img')?'ok':'missing'})",
			);

		win.webContents.send("panel:entry", entry({}));
		win.webContents.send("panel:html", { id: 1, html: "<p>这是一张<strong>图片</strong>。</p>" });
		await new Promise((r) => setTimeout(r, 300));
		console.log("panel  ->", await shown());

		// 翻页翻走后迟到的流式片段不能再改页面
		win.webContents.send("panel:html", { id: 99, html: "<p>不该出现</p>" });
		await new Promise((r) => setTimeout(r, 150));
		console.log("stale  ->", await api("document.getElementById('answer').textContent"));

		// 收尾：光标停掉，翻页按钮按位置置灰（第 1 条 prev 灰、第 3 条 next 灰）
		win.webContents.send("panel:entry", entry({ status: "done", index: 3, html: "<p>答完了</p>" }));
		await new Promise((r) => setTimeout(r, 200));
		console.log("done   ->", await shown());

		// --- 4. 错误分支 ---
		win.webContents.send("panel:entry", entry({ status: "done", error: "boom", html: "" }));
		await new Promise((r) => setTimeout(r, 200));
		console.log("error  ->", await shown());

		// --- 4b. 一次性提示（不进历史） ---
		win.webContents.send("panel:notice", "没有选中的文字，剪切板也是空的");
		await new Promise((r) => setTimeout(r, 200));
		console.log("notice ->", await shown());

		// --- 4d. 卡片操作：删除 / 复制按钮 ---
		let deleted = 0;
		let copied = 0;
		ipcMain.on("panel:delete", () => {
			deleted += 1;
		});
		ipcMain.on("panel:copy", () => {
			copied += 1;
		});
		win.webContents.send("panel:entry", entry({ id: 11, index: 1, total: 1, kind: "text", text: "T", html: "<p>卡片</p>", status: "done" }));
		await new Promise((r) => setTimeout(r, 150));
		const enabledWithCard = await api("!document.getElementById('remove').disabled && !document.getElementById('copy').disabled");
		await api("document.getElementById('remove').click(); document.getElementById('copy').click();");
		await new Promise((r) => setTimeout(r, 150));
		const showsCheck = await api("getComputedStyle(document.querySelector('#copy .ok')).display !== 'none' && getComputedStyle(document.querySelector('#copy .icon')).display === 'none'");
		win.webContents.send("panel:entry", null);
		await new Promise((r) => setTimeout(r, 250));
		console.log(
			"delete ->",
			JSON.stringify({
				有卡片时可用: enabledWithCard,
				收到删除: deleted,
				收到复制: copied,
				复制后显示对勾: showsCheck,
				空态按钮置灰: await api("document.getElementById('remove').disabled && document.getElementById('copy').disabled"),
				空态文案: await api("document.getElementById('answer').textContent"),
			}),
		);

		// --- 4e. 待发送的卡片：内容框自己就是发送按钮，点了才发出去 ---
		let sent = 0;
		ipcMain.on("panel:send", () => {
			sent += 1;
		});
		const previewState = () =>
			api(
				"JSON.stringify({提示可见:getComputedStyle(document.querySelector('#preview .send')).display!=='none',可点:!document.getElementById('preview').disabled,指针:getComputedStyle(document.getElementById('preview')).cursor,思考中:!!getComputedStyle(document.getElementById('answer'),'::after').content.includes('思考')})",
			);

		win.webContents.send("panel:entry", entry({ id: 21, index: 1, total: 1, kind: "text", text: "T", status: "pending", html: "" }));
		await new Promise((r) => setTimeout(r, 150));
		const pending = await previewState();
		await api("document.getElementById('preview').click()");
		await new Promise((r) => setTimeout(r, 150));

		// 已经答过的卡片不能再点，免得重复发
		win.webContents.send("panel:entry", entry({ id: 21, index: 1, total: 1, kind: "text", text: "T", status: "done", html: "<p>答完了</p>" }));
		await new Promise((r) => setTimeout(r, 150));
		await api("document.getElementById('preview').click()");
		await new Promise((r) => setTimeout(r, 150));
		console.log(
			"send   ->",
			JSON.stringify({
				待发送: JSON.parse(pending),
				收到发送: sent,
				答完后: JSON.parse(await previewState()),
			}),
		);

		// --- 4c. 滚动：换一条记录回到顶部，同一条重发（收尾）别把读完滚到底的页面拽回去 ---
		const long = `<p>${"很长的一段答案。".repeat(200)}</p>`;
		const post = (id) => win.webContents.send("panel:entry", entry({ id, index: id, total: 2, kind: "text", text: "T", html: long, status: "done" }));
		post(7);
		await new Promise((r) => setTimeout(r, 150));
		await api("document.querySelector('main').scrollTop = document.querySelector('main').scrollHeight");
		post(7);
		await new Promise((r) => setTimeout(r, 150));
		const kept = await api("document.querySelector('main').scrollTop > 0");
		post(8);
		await new Promise((r) => setTimeout(r, 150));
		console.log("scroll ->", JSON.stringify({ 同一条保持位置: kept, 换一条回到顶部: await api("document.querySelector('main').scrollTop === 0") }));

		console.log("savedImage items:", (await savedImage).length);

		// --- 5. settings.html（用桩 handler 验证 IPC 往返与 ok/error 分支） ---
		ipcMain.handle("config:load", () => ({ ok: true, value: { apiKey: "", model: "" } }));
		ipcMain.handle("models:list", () => ({
			ok: true,
			value: [
				{ id: "deepseek-v4-flash", name: "deepseek-v4-flash" },
				{ id: "deepseek-v4-pro", name: "deepseek-v4-pro" },
			],
		}));
		ipcMain.handle("config:save", () => ({ ok: true, value: { apiKey: "sk-test", model: "deepseek-v4-pro" } }));

		const sw = new BrowserWindow({
			show: false,
			webPreferences: {
				preload: path.join(ROOT, "dist", "preload.mjs"),
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: false,
			},
		});
		await sw.loadFile(path.join(ROOT, "src", "settings.html"));
		const sapi = (expr) => sw.webContents.executeJavaScript(expr);
		console.log("settings bridge ->", await sapi("typeof window.whatsthis"));

		await sapi("document.getElementById('apiKey').value='sk-test'; document.getElementById('fetch').click();");
		await new Promise((r) => setTimeout(r, 400));
		console.log(
			"settings fetch  ->",
			await sapi(
				"JSON.stringify({options:document.getElementById('model').options.length,enabled:!document.getElementById('model').disabled,status:document.getElementById('status').textContent,saveDisabled:document.getElementById('save').disabled})",
			),
		);

		await sapi("document.getElementById('save').click();");
		await new Promise((r) => setTimeout(r, 300));
		console.log("settings save   ->", await sapi("document.getElementById('status').textContent"));

		// --- 6. 选区读取：未授权时应静默返回空串，不能抛异常 ---
		const { inspectSelection } = await import("../dist/selection.js");
		const reading = inspectSelection();
		console.log("selection text  ->", JSON.stringify(reading.text));
		console.log("selection report:\n" + reading.report.replace(/^/gm, "  "));

		// --- 8. 历史：去重、翻页、追问沿用会话 ---
		const { createHistory, push, go, viewOf, contextFor, copyTextOf, removeCurrent } = await import("../dist/history.js");
		const h = createHistory();
		const ask = (text) => ({ kind: "text", model: "m", key: `取材:${text}`, text, question: `这是什么？\n\n${text}` });

		push(h, ask("T"), false);
		push(h, ask("T"), false);
		console.log("history 去重 ->", JSON.stringify({ total: h.entries.length, index: h.index, id: h.entries[0].id }));

		const first = push(h, ask("X"), false);
		first.answer = "X 的解释。";
		const back = go(h, -1);
		console.log("history 翻页 ->", JSON.stringify({ 退回到: back && back.text, 到头: go(h, -1) }));

		// 翻回来再追问：沿用被追问那条的会话，并把它的问答当上下文带上
		go(h, 1);
		const follow = push(h, { kind: "followup", model: "m", key: "追问:为什么", text: "为什么", question: "为什么" }, true);
		console.log(
			"history 追问 ->",
			JSON.stringify({ 会话: follow.thread, 同会话: follow.thread === first.thread, 上下文: contextFor(h, follow) }),
		);
		console.log("history 视图 ->", JSON.stringify(viewOf(h, follow)));

		// 删除：删最后一条会退回上一条，删光返回 null
		const del = createHistory();
		const one = (t) => { const e = push(del, ask(t), false); e.answer = `答 ${t}`; return e; };
		one("1");
		one("2");
		one("3");
		const afterDelete = removeCurrent(del);
		removeCurrent(del);
		console.log(
			"history 删除 ->",
			JSON.stringify({ 删末条后退回: afterDelete && afterDelete.text, 删光: removeCurrent(del), 剩几条: del.entries.length }),
		);

		// 复制：问题 + 回答全文；图片卡片没有原文，退回用问题本身
		const copiedText = createHistory();
		const textCard = push(copiedText, ask("原文"), false);
		textCard.answer = "回答全文";
		const imageCard = push(copiedText, { kind: "image", model: "m", key: "图片", question: "这是什么？" }, false);
		imageCard.answer = "图里是一只猫";
		console.log("history 复制 ->", JSON.stringify({ 文字卡片: copyTextOf(textCard), 图片卡片: copyTextOf(imageCard) }));

		// 过期：一个多小时前的记录，下次触碰历史时清掉，翻页不会落到它上面
		const aged = createHistory();
		push(aged, ask("旧"), false);
		push(aged, ask("新"), false);
		aged.entries[0].createdAt = Date.now() - 61 * 60 * 1000;
		go(aged, -1);
		console.log("history 过期 ->", JSON.stringify({ 剩: aged.entries.map((e) => e.text), 现在看: aged.entries[aged.index].text }));

		// 正看着的那条不当场消失，离开后再清
		const pinned = createHistory();
		push(pinned, ask("A"), false);
		const watched = push(pinned, ask("B"), false);
		watched.createdAt = Date.now() - 61 * 60 * 1000; // 正看着的这条过期了
		push(pinned, ask("C"), false);
		const survived = pinned.entries.some((e) => e.text === "B");
		go(pinned, -1);
		console.log(
			"history 钉住 ->",
			JSON.stringify({ 看着时不消失: survived, 离开后被清: !pinned.entries.some((e) => e.text === "B") }),
		);

		// --- 7. Markdown：转义原始 HTML，剥掉非 http/https 链接 ---
		const { renderMarkdown } = await import("../dist/markdown.js");
		const md = renderMarkdown("# 标题\n\n- **粗体**\n\n<script>alert(1)</script>\n\n[安全](https://example.com) [危险](javascript:alert(1))");
		console.log(
			"markdown ->",
			JSON.stringify({
				heading: md.includes("<h1>标题</h1>"),
				bold: md.includes("<strong>粗体</strong>"),
				scriptEscaped: md.includes("&lt;script&gt;") && !md.includes("<script>"),
				safeLink: md.includes('href="https://example.com"'),
				dangerousLinkStripped: !md.includes("javascript:"),
			}),
		);
	} catch (err) {
		console.error("FAILED:", err);
	} finally {
		await clipboard.writeText(saved);
		console.log("clipboard text restored");
		app.exit(0);
	}
}

app.whenReady().then(main);
