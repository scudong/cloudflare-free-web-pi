import type { FileArtifact } from "../types";

/** 文件产出卡片（v0.22.0）：write_file 产生的文件直接可点开预览。 */
export function ArtifactCard({ file, onOpen }: { file: FileArtifact; onOpen?: (name: string) => void }) {
	return (
		<button
			type="button"
			onClick={() => onOpen?.(file.name)}
			disabled={!onOpen}
			className="group flex w-full max-w-sm items-center gap-3 rounded-xl border border-slate-700/70 bg-slate-900/80 px-3 py-2 text-left transition-colors enabled:hover:border-sky-500/50 enabled:hover:bg-slate-800/80 disabled:cursor-default"
		>
			<span aria-hidden className="text-lg">
				📄
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-[13px] font-medium text-slate-100">{file.name}</span>
				<span className="block text-[11px] text-slate-500">
					{typeof file.size === "number" ? `${file.size.toLocaleString()} 字符` : "已生成"}
				</span>
			</span>
			{onOpen && (
				<span className="shrink-0 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 transition-colors group-hover:border-sky-500/50 group-hover:text-sky-300">
					打开
				</span>
			)}
		</button>
	);
}
