import type { ImageContent } from "@mariozechner/pi-ai";
import { clipboard, nativeImage } from "electron";

/** 图片最长边超过这个值就先缩放，避免请求体过大被拒。 */
const MAX_IMAGE_EDGE = 2048;

export type Clip = { kind: "image"; image: ImageContent; dataUrl: string } | { kind: "text"; text: string };

/** 读取剪切板。有图片就返回图片，否则返回文字。 */
export async function readClipboard(): Promise<Clip> {
	const text = (await clipboard.readText()).trim();

	for (const item of await clipboard.read()) {
		const imageType = item.types.find((type) => type.startsWith("image/"));
		if (!imageType) continue;

		const blob = (await item.getType(imageType)) as Blob;
		let image = nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer()));
		if (image.isEmpty()) continue;

		const { width, height } = image.getSize();
		const longest = Math.max(width, height);
		if (longest > MAX_IMAGE_EDGE) {
			const scale = MAX_IMAGE_EDGE / longest;
			image = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale) });
		}

		const base64 = image.toPNG().toString("base64");
		return {
			kind: "image",
			image: { type: "image", data: base64, mimeType: "image/png" },
			dataUrl: `data:image/png;base64,${base64}`,
		};
	}

	return { kind: "text", text };
}

/**
 * data URL 还原成 pi-ai 的 ImageContent —— readClipboard 的逆操作。
 * 历史记录里只留 data URL（内存里放一份就够），真要发给模型时才还原。
 */
export function imageFromDataUrl(dataUrl: string): ImageContent {
	return {
		type: "image",
		mimeType: dataUrl.slice(5, dataUrl.indexOf(";", 5)),
		data: dataUrl.slice(dataUrl.indexOf(",") + 1),
	};
}
