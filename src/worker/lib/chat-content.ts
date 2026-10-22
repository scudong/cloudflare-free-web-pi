/**
 * 聊天输入的内容块（ADR-0001 §5.6 共享纯函数）：有图片时用块数组，否则纯文本。
 * 原 `worker.ts` 的 toImageBlocks / userContent 原样迁出，行为不变。
 */
export function toImageBlocks(images: string[] | undefined): { type: "image"; data: string; mimeType: string }[] {
	if (!images?.length) return [];
	const blocks: { type: "image"; data: string; mimeType: string }[] = [];
	for (const url of images.slice(0, 4)) {
		const match = /^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/.exec(url);
		if (!match) continue;
		blocks.push({ type: "image", data: match[2]!, mimeType: match[1]! });
	}
	return blocks;
}

export function userContent(
	message: string,
	images: string[] | undefined,
): string | { type: string; [key: string]: unknown }[] {
	const blocks = toImageBlocks(images);
	if (!blocks.length) return message;
	return [{ type: "text", text: message || "（图片）" }, ...blocks];
}
