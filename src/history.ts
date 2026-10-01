/**
 * 浮窗的记忆：一条记录 = 一次提问 + 一次回答。
 *
 * 顶部左右箭头在这些记录之间翻页；连着问同一个问题只保留最近一条；
 * 在浮窗里选中内容再点图标算「追问」，沿用被追问那条的会话编号。
 */

/** 这次问题从哪来。followup = 在浮窗里选中内容发起的追问。 */
export type EntryKind = "selection" | "followup" | "text" | "image";

/**
 * 卡片的状态。
 *
 * `pending` 是刻意的中间态：点菜单栏图标只把内容摆出来，**不发出去**，
 * 用户点一下内容框才轮到 running。剪切板里可能是密码、聊天记录，
 * 不能让「点一下图标」这种动作把内容送出本机。
 */
export type EntryStatus = "pending" | "running" | "done";

export interface Entry {
	id: number;
	/** 会话编号：追问沿用被追问那条的编号，翻页时靠它把上下文串起来 */
	thread: number;
	kind: EntryKind;
	model: string;
	/** 去重键：连着问同一个问题时靠它认出重复 */
	key: string;
	/** 发给模型的那一问（首次是「这是什么？」加原文，追问是选中的那句话） */
	question: string;
	/** 浮窗里预览用的原文 */
	text?: string;
	/** 图片预览用的 data URL */
	dataUrl?: string;
	/** 模型回答的 Markdown 原文，追问时当上下文用 */
	answer: string;
	/** answer 渲染好的 HTML */
	html: string;
	/** 出错提示；有它就不显示 html 了 */
	error?: string;
	/** 待发送 / 生成中 / 完成 */
	status: EntryStatus;
	/** 记下来的时刻，用来判断过期 */
	createdAt: number;
}

export interface History {
	entries: Entry[];
	/** 当前看到第几条；-1 表示一条都还没有 */
	index: number;
	nextId: number;
	nextThread: number;
}

/** 新记录里由调用方决定的部分，其余字段由 push 填。 */
export type NewEntry = Pick<Entry, "kind" | "model" | "key" | "question"> & Pick<Entry, "text" | "dataUrl">;

/** 记录上限，超了丢最早的一条。图片的 data URL 很占内存，不设上限跑久了会一直涨。 */
const MAX_ENTRIES = 50;
/** 每条记录的寿命，到点就丢。 */
const TTL_MS = 60 * 60 * 1000;
/** 预览和追问上下文都不必搬整篇原文，超了就截断。 */
const MAX_CHARS = 2000;

function clip(text: string): string {
	return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text;
}

export function createHistory(): History {
	return { entries: [], index: -1, nextId: 1, nextThread: 1 };
}

/**
 * 丢掉过期的记录。
 *
 * 正显示在浮窗里的那条不动 —— 不能让用户读着读着卡片自己没了。
 * 它会在下一次触碰历史时（翻页 / 新增 / 删除）被清掉。
 */
export function prune(h: History, now = Date.now()): void {
	const shown = h.entries[h.index];
	const kept = h.entries.filter((e) => e === shown || now - e.createdAt < TTL_MS);
	if (kept.length === h.entries.length) return;
	h.entries.length = 0;
	h.entries.push(...kept);
	h.index = kept.indexOf(shown);
}

/**
 * 记下这一轮提问，并把浮窗定位到它。
 *
 * - 与上一条是同一个问题时替换掉上一条 —— 连续重复只保留最近的一条。
 * - 追问沿用当前正看着那条的会话编号（用户可能翻回去再追问），新话题另起一个。
 */
export function push(h: History, entry: NewEntry, followUp: boolean): Entry {
	prune(h);

	const viewed = h.entries[h.index];
	const last = h.entries[h.entries.length - 1];
	const full: Entry = {
		...entry,
		id: h.nextId++,
		thread: followUp && viewed ? viewed.thread : h.nextThread++,
		answer: "",
		html: "",
		status: "pending",
		createdAt: Date.now(),
	};

	if (last && last.key === entry.key) h.entries[h.entries.length - 1] = full;
	else h.entries.push(full);

	if (h.entries.length > MAX_ENTRIES) h.entries.shift();
	h.index = h.entries.length - 1;
	return full;
}

/** 翻页，delta 为 ±1。已经在头/尾就返回 null。 */
export function go(h: History, delta: number): Entry | null {
	prune(h);
	const next = Math.min(Math.max(h.index + delta, 0), h.entries.length - 1);
	if (next === h.index) return null;
	h.index = next;
	return h.entries[next];
}

/** 删掉正看着的那条，返回接下来该显示的一条；删光了返回 null。 */
export function removeCurrent(h: History): Entry | null {
	prune(h);
	if (h.index < 0) return null;
	h.entries.splice(h.index, 1);
	// 删的是最后一条就往回退一条，否则原位显示后面那条顶上来的
	if (h.index >= h.entries.length) h.index = h.entries.length - 1;
	return h.entries[h.index] ?? null;
}

/** 追问时带给模型的上下文：同一条会话里最近的几轮问答。 */
export function contextFor(h: History, entry: Entry, limit = 4): string {
	prune(h);
	return h.entries
		.filter((e) => e.thread === entry.thread && e.answer)
		.slice(-limit)
		.map((e) => `问：${clip(e.question)}\n答：${clip(e.answer)}`)
		.join("\n\n");
}

/** 发给浮窗的展示数据：一条记录，外加它在历史里的位置（顶部「3/9」用它）。 */
export interface EntryView {
	id: number;
	index: number;
	total: number;
	kind: EntryKind;
	model: string;
	text?: string;
	dataUrl?: string;
	html: string;
	error?: string;
	status: EntryStatus;
}

/** 「复制」按钮复制的内容：卡片上摆出来的那个问题，加回答全文。 */
export function copyTextOf(entry: Entry): string {
	// 首次提问的 question 是「这是什么？\n\n原文」，这里优先用 text，
	// 免得把那句问话一起复制走；追问时 text 本来就是那句追问。
	const asked = entry.text || entry.question;
	return [asked, entry.answer].filter(Boolean).join("\n\n");
}

export function viewOf(h: History, entry: Entry): EntryView {
	return {
		id: entry.id,
		index: h.entries.indexOf(entry) + 1,
		total: h.entries.length,
		kind: entry.kind,
		model: entry.model,
		text: entry.text && clip(entry.text),
		dataUrl: entry.dataUrl,
		html: entry.html,
		error: entry.error,
		status: entry.status,
	};
}
