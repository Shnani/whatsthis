const BASE_URL = "https://api.deepseek.com";

export interface RemoteModel {
	id: string;
	name: string;
}

interface ModelsResponse {
	data?: { id?: string }[];
}

/** 拉取 DeepSeek 官方模型列表。任何失败都抛出可直接展示给用户的错误。 */
export async function listModels(apiKey: string): Promise<RemoteModel[]> {
	if (!apiKey.trim()) throw new Error("请先填写 API Key");

	let res: Response;
	try {
		res = await fetch(`${BASE_URL}/models`, {
			headers: { Authorization: `Bearer ${apiKey.trim()}` },
		});
	} catch (err) {
		throw new Error(`无法连接 DeepSeek：${(err as Error).message}`);
	}

	if (!res.ok) {
		const body = (await res.text()).slice(0, 300);
		throw new Error(`获取模型列表失败（HTTP ${res.status}）：${body}`);
	}

	const body = (await res.json()) as ModelsResponse;
	const ids = (body.data ?? [])
		.map((m) => m.id)
		.filter((id): id is string => typeof id === "string" && id.length > 0)
		.sort();

	if (ids.length === 0) throw new Error("DeepSeek 没有返回任何模型");

	return ids.map((id) => ({ id, name: id }));
}
