import { CANCELLED, ask, type AskRun } from "./agent.js";
import { imageFromDataUrl } from "./clipboard.js";
import type { Config } from "./config.js";
import { contextFor, type Entry, type History } from "./history.js";
import { renderMarkdown } from "./markdown.js";

/** 流式回答的 Markdown 重渲染间隔：太密浪费，太疏卡顿 */
const RENDER_INTERVAL_MS = 80;

export interface AskHandle {
	/** 跑完就 resolve —— 成功、出错、被取消都算跑完 */
	done: Promise<void>;
	abort(): void;
}

/**
 * 跑一轮问答，把流式片段节流渲染进 entry。
 *
 * deliver 决定渲染好的 HTML 推给谁：浮窗正显示着这条才推，翻页翻走了就别再动页面。
 * entry 的 answer / html / status / error 都在这里落定，调用方只管重画。
 */
export function runAsk(opts: {
	entry: Entry;
	history: History;
	config: Config;
	deliver: (html: string) => void;
	/** 整条重画（不是推流式片段）。搜索起落时靠它把状态标出来 */
	repaint: () => void;
}): AskHandle {
	const { entry, history, config, deliver, repaint } = opts;

	// Markdown 每来一个分片都要整段重渲染，所以节流；收尾时再补一次完整渲染
	let answer = "";
	let timer: NodeJS.Timeout | null = null;
	const flush = () => {
		timer = null;
		entry.answer = answer;
		entry.html = renderMarkdown(answer);
		deliver(entry.html);
	};

	let run: AskRun | null = null;
	const done = (async () => {
		try {
			run = ask({
				apiKey: config.apiKey,
				model: config.model,
				question: entry.question,
				context: entry.kind === "followup" ? contextFor(history, entry) : undefined,
				image: entry.kind === "image" && entry.dataUrl ? imageFromDataUrl(entry.dataUrl) : undefined,
				onDelta: (delta) => {
					answer += delta;
					if (!timer) timer = setTimeout(flush, RENDER_INTERVAL_MS);
				},
				onTool: (active) => {
					entry.searching = active;
					repaint();
				},
			});
			await run.done;
		} catch (err) {
			const message = (err as Error).message;
			// 中途关掉浮窗时，已经吐出来的半截回答留着就行，别把它换成一条报错
			if (message !== CANCELLED || !answer) entry.error = message;
		} finally {
			if (timer) clearTimeout(timer);
			entry.answer = answer;
			entry.html = renderMarkdown(answer);
			entry.status = "done";
			// 搜索中途被中断时 tool_execution_end 未必到，别留下一个卡在「正在搜索网络…」的卡片
			entry.searching = false;
		}
	})();

	// done 的同步段已经跑过，这里 run 一定已经赋上值了
	return { done, abort: () => run?.abort() };
}
