/**
 * 复制纯文本（NERE-43，R-FE-5）：平台能力收口到 lib，新组件只从这里取。
 * 安全上下文优先 Clipboard API；http 内网地址等场景退回 execCommand。
 * 既有 ShareLinkCard / ShareDialog / Composer 的 4 份实现本轮不动，全量收口归 [ARCH] R1。
 */
export async function copyText(text: string): Promise<boolean> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// 无权限 / 非安全上下文：落到下面的兜底
		}
	}
	if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.top = "0";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);
	try {
		textarea.select();
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		document.body.removeChild(textarea);
	}
}
