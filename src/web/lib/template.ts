/** 提示模板展开（v0.31.0）：把 `$1..$9`、`$@` / `$ARGUMENTS` 替换成参数。 */

/**
 * 展开模板。
 * - `$1`..`$9` 取对应参数
 * - `$@` / `$ARGUMENTS` 取全部参数（空格连接）
 * - 没有对应参数时保留原样，避免误删内容
 */
export function expandTemplate(content: string, args: string[] = []): string {
	const all = args.join(" ");
	return content
		.replace(/\$ARGUMENTS|\$@/g, all)
		.replace(/\$([1-9])/g, (whole, index: string) => {
			const value = args[Number(index) - 1];
			return value === undefined ? whole : value;
		});
}

/** 模板是否含占位符。 */
export function hasPlaceholders(content: string): boolean {
	return /\$ARGUMENTS|\$@|\$[1-9]/.test(content);
}
