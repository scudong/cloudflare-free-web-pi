import { Icon } from "./Icon";
import type { FileArtifact } from "../types";

/** 文件产出卡片（v0.22.0；v0.25.2：Arco cyan 配色 + 与其它气泡同宽）。 */
export function ArtifactCard({ file, onOpen }: { file: FileArtifact; onOpen?: (name: string) => void }) {
	return (
		<button
			type="button"
			onClick={() => onOpen?.(file.name)}
			disabled={!onOpen}
			className="group flex w-full items-center gap-3 rounded-xl border border-cyan-500/35 bg-cyan-950/40 px-3 py-2 text-left transition-colors enabled:hover:border-cyan-500/60 enabled:hover:bg-cyan-950/60 disabled:cursor-default"
		>
			<Icon name="file" className="h-5 w-5 shrink-0 text-cyan-400" />
			<span className="min-w-0 flex-1">
				<span className="block truncate text-[13px] font-medium text-slate-100">{file.name}</span>
				<span className="block text-[11px] text-cyan-300/80">
					{typeof file.size === "number" ? `${file.size.toLocaleString()} 字符` : "已生成"}
				</span>
			</span>
			{onOpen && (
				<span className="shrink-0 rounded-md border border-cyan-500/40 px-2 py-1 text-[11px] text-cyan-300 transition-colors group-hover:border-cyan-400 group-hover:text-cyan-200">
					打开
				</span>
			)}
		</button>
	);
}
