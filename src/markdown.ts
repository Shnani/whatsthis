import { Marked } from "marked";

/**
 * 只放行 http/https。挡掉 `javascript:` / `data:` / `file:` 这类，
 * 它们进了 DOM 就是可执行内容。openExternal 也复用这个判断。
 */
export function safeExternalUrl(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === "http:" || parsed.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const marked = new Marked({
	gfm: true,
	// 模型的回答多是短句换行，按 GitHub 的「单换行 = 换行」处理更贴合阅读习惯
	breaks: true,
});

marked.use({
	renderer: {
		// 原始 HTML 一律当纯文本。模型可能会把剪切板里的 HTML 片段原样吐出来，
		// 直接 innerHTML 进去就是注入。
		html(token) {
			return escapeHtml(token.text);
		},
		link(token) {
			const label = this.parser.parseInline(token.tokens);
			const href = safeExternalUrl(token.href);
			return href ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
		},
	},
});

/** Markdown → HTML。只用于浮窗内的 innerHTML，链接已在上面过滤过。 */
export function renderMarkdown(source: string): string {
	return marked.parse(source) as string;
}
