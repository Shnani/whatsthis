import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

/**
 * 联网检索：工具。
 *
 * pi-agent-core 只提供工具执行框架，自带零工具（`state.tools` 默认空数组），
 * 所以这里自己拼一个交给 agent，由模型在上下文里决定要不要用。
 *
 * 走的是抓搜索结果页 HTML，不引 SDK、不加第二个 Key。代价是解析天生脆：
 * Bing 改版或限流都会失效，所以抠不到就抛异常，别伪装成「没搜到」。
 */

/** 搜索引擎。要换引擎只动这一行（下面 parseResults 的抠法也得跟着换）。 */
const ENDPOINT = "https://cn.bing.com/search";
/** 不带浏览器 UA 会被结果页挡掉。 */
const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
/** 答案被 system prompt 限在 200 字内，喂多了只会挤掉答案本身。 */
const MAX_RESULTS = 5;
/** 挂死的请求不能拖着卡片停在「正在搜索网络…」。 */
const TIMEOUT_MS = 10_000;

export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

/**
 * 命名实体只列结果页真的会用的那几个 —— 实测一页里 `&amp;` `&ensp;` `&nbsp;` 占绝大多数。
 * 认不出来的原样留着：搬一整张 HTML 实体表进来不值得，剩余那点噪声模型也读得懂。
 */
const NAMED: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ensp: " ",
	emsp: " ",
	middot: "·",
	hellip: "…",
	mdash: "—",
	ndash: "–",
};

/** 去标签 + 解实体。URL 里也会有 `&amp;`，所以链接同样得过一遍。 */
function strip(html: string): string {
	return (
		html
			.replace(/<[^>]*>/g, "")
			.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
				if (code[0] !== "#") return NAMED[code.toLowerCase()] ?? whole;
				// 十进制那支顺带吃下 `&#0183;` 这种带前导零的（Bing 用得很勤）
				const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
				return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
			})
			.replace(/\s+/g, " ")
			.trim()
	);
}

/**
 * 从搜索结果页里抠出条目。
 *
 * 单独导出是为了测试能喂固定 HTML 进来 —— 网络那半截没法测，抠的这一半必须能测。
 */
export function parseResults(html: string, limit = MAX_RESULTS): SearchHit[] {
	const hits: SearchHit[] = [];
	// 每条结果是 <li class="b_algo">，到下一条 <li> 或 </ol> 为止
	for (const block of html.match(/<li class="b_algo"[\s\S]*?(?=<li class=|<\/ol>)/g) ?? []) {
		const head = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
		if (!head) continue;
		// 摘要首选 b_lineclamp 那个 <p>；Bing 偶尔换类名，退到块里第一个 <p>
		const cap = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/.exec(block) ?? /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
		hits.push({ title: strip(head[2]), url: strip(head[1]), snippet: cap ? strip(cap[1]) : "" });
		if (hits.length >= limit) break;
	}
	return hits;
}

/** 搜一次。网络错误、非 200、一条都没抠到，都抛出去。 */
export async function search(term: string, signal?: AbortSignal): Promise<SearchHit[]> {
	const url = `${ENDPOINT}?q=${encodeURIComponent(term)}`;

	let res: Response;
	try {
		res = await fetch(url, {
			headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
			// 用户中途取消、或这次搜索超时，都得能脱身
			signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err) {
		// 用户取消时把原始错误原样抛出去：上游靠它区分「取消」和「真出错」
		if (signal?.aborted) throw err;
		throw new Error(`搜索失败：${(err as Error).message}`);
	}

	if (!res.ok) throw new Error(`搜索失败（HTTP ${res.status}）`);

	const hits = parseResults(await res.text());
	if (hits.length === 0) throw new Error("搜索结果页里一条都没解析出来（引擎可能改版了）");
	return hits;
}

/** 工具入参。单独声明是为了让 execute 拿到 query: string 而不是 unknown。 */
const parameters = Type.Object({ query: Type.String({ description: "搜索词" }) });

/** 交给 pi-agent-core 的工具。模型自己决定何时调。 */
export const webSearchTool: AgentTool<typeof parameters> = {
	name: "web_search",
	label: "搜索网络",
	description:
		"在搜索引擎上查一次，拿到标题、链接和摘要。只在你需要最新信息、或对事实没把握时用；常识解释和纯代码问题不用查。",
	parameters,
	execute: async (_toolCallId, { query }, signal) => {
		const hits = await search(query, signal);
		const text = hits.map((h, i) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet}`).join("\n\n");
		return { content: [{ type: "text", text }], details: { query, hits } };
	},
};
