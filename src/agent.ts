import { Agent } from "@mariozechner/pi-agent-core";
import { getModels, type ImageContent, type Model } from "@mariozechner/pi-ai";

const BASE_URL = "https://api.deepseek.com";

const SYSTEM_PROMPT = [
	"你是 macOS 菜单栏助手。用户会把剪切板里的内容（文字或图片）发给你，并问「这是什么？」。",
	"用中文直接回答它是什么，不要寒暄、不要复述问题。",
	"图片：说明主体、场景、以及图中可读的关键文字。",
	"代码或报错：说明语言/技术栈、用途、以及关键问题在哪。",
	"普通文字：说明它是什么（术语、句子、链接、数据等）并给出必要的解释。",
	"回答控制在 200 字以内，除非内容确实需要展开。",
].join("\n");

/**
 * 把 DeepSeek 的模型 id 变成 pi-ai 的 Model。
 * DeepSeek 官方模型支持视觉输入，pi-ai 注册表里标的是纯文本，这里统一放开 image。
 */
export function resolveModel(id: string): Model<any> {
	const known = getModels("deepseek").find((m) => m.id === id);
	const base: Model<any> = known ?? {
		id,
		name: id,
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
	return { ...base, id, input: ["text", "image"] };
}

export interface AskOptions {
	apiKey: string;
	model: string;
	question: string;
	/** 剪切板文字；与 image 二选一 */
	text?: string;
	/** 剪切板图片；与 text 二选一 */
	image?: ImageContent;
	onDelta: (delta: string) => void;
}

export interface AskRun {
	done: Promise<void>;
	abort: () => void;
}

/** 起一个一次性的 agent 跑完整轮问答。失败通过 done 的 rejection 抛出。 */
export function ask(opts: AskOptions): AskRun {
	const agent = new Agent({
		initialState: {
			systemPrompt: SYSTEM_PROMPT,
			model: resolveModel(opts.model),
		},
		getApiKey: () => opts.apiKey,
	});

	let failure: string | null = null;

	agent.subscribe((event) => {
		if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
			opts.onDelta(event.assistantMessageEvent.delta);
			return;
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const { stopReason, errorMessage } = event.message;
			if (stopReason === "error") failure = errorMessage || "模型调用失败";
			else if (stopReason === "aborted") failure = "已取消";
		}
	});

	const input = opts.text ? `${opts.question}\n\n${opts.text}` : opts.question;
	const images: ImageContent[] = opts.image ? [opts.image] : [];

	const done = (async () => {
		await agent.prompt(input, images);
		if (failure) throw new Error(failure);
	})();

	return { done, abort: () => agent.abort() };
}
