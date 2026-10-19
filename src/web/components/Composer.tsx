import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { SkillInfo } from "../types";

interface ComposerProps {
	pending: boolean;
	/** text 为文字，images 为 data URL 列表（v0.12.0，多模态）。 */
	onSend: (text: string, images: string[]) => void;
	onStop: () => void;
	/** 已安装技能（v0.23.0）：输入 / 唤起，选中后把「/技能名」写进输入框。 */
	skills: SkillInfo[];
}

const MAX_IMAGES = 4;
/** 压缩到最长边 1568px，PNG 有透明保留 PNG，否则转 JPEG。 */
const MAX_EDGE = 1568;

/** 读文件 → 缩放 → data URL；失败返回 null。 */
function compressImage(file: File): Promise<string | null> {
	return new Promise((resolve) => {
		const reader = new FileReader();
		reader.onerror = () => resolve(null);
		reader.onload = () => {
			const img = new Image();
			img.onerror = () => resolve(null);
			img.onload = () => {
				try {
					const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
					const canvas = document.createElement("canvas");
					canvas.width = Math.max(1, Math.round(img.width * scale));
					canvas.height = Math.max(1, Math.round(img.height * scale));
					const ctx = canvas.getContext("2d");
					if (!ctx) return resolve(null);
					ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
					// 有透明通道时保留 PNG，避免黑底
					const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
					let transparent = false;
					for (let i = 3; i < data.length; i += 4) {
						if (data[i]! < 255) {
							transparent = true;
							break;
						}
					}
					resolve(transparent ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.85));
				} catch {
					resolve(null);
				}
			};
			img.src = String(reader.result);
		};
		reader.readAsDataURL(file);
	});
}

const MAX_HEIGHT = 160;
const SKILL_MENU_LIMIT = 8;

/** 找出光标前正在输入的 /技能 片段（行首或空格后）。 */
function detectSkillToken(value: string, caret: number): { start: number; query: string } | null {
	const upto = value.slice(0, caret);
	const match = /(^|\s)\/([^\s/]*)$/.exec(upto);
	if (!match) return null;
	return { start: upto.lastIndexOf("/"), query: match[2] ?? "" };
}

export function Composer({ pending, onSend, onStop, skills }: ComposerProps) {
	const [text, setText] = useState("");
	const [images, setImages] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	/** 技能菜单（v0.23.0）：{start, query} 记录要替换的片段位置。 */
	const [skillMenu, setSkillMenu] = useState<{ start: number; query: string } | null>(null);
	const [skillIndex, setSkillIndex] = useState(0);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	const matches = skillMenu
		? skills
				.filter((s) => {
					const q = skillMenu.query.toLowerCase();
					if (!q) return true;
					return s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q);
				})
				.slice(0, SKILL_MENU_LIMIT)
		: [];
	const menuOpen = skillMenu !== null && matches.length > 0;

	/** 选中技能：把「/查询」替换成「/技能名 」，光标移到末尾。 */
	const pickSkill = (name: string) => {
		const el = textareaRef.current;
		const start = skillMenu?.start ?? 0;
		const caret = el?.selectionStart ?? text.length;
		const next = `${text.slice(0, start)}/${name} ${text.slice(caret)}`;
		setText(next);
		setSkillMenu(null);
		setSkillIndex(0);
		// 下一帧把光标放到技能名之后
		window.requestAnimationFrame(() => {
			const pos = start + name.length + 2;
			el?.focus();
			el?.setSelectionRange(pos, pos);
		});
	};

	const addFiles = (files: FileList | File[]) => {
		const list = Array.from(files).filter((f) => /^image\/(png|jpe?g|webp)$/.test(f.type));
		if (!list.length) return;
		void (async () => {
			setBusy(true);
			setNotice(null);
			const room = MAX_IMAGES - images.length;
			if (room <= 0) {
				setNotice(`最多 ${MAX_IMAGES} 张图片`);
				setBusy(false);
				return;
			}
			const accepted = list.slice(0, room);
			if (list.length > room) setNotice(`最多 ${MAX_IMAGES} 张，已保留前 ${room} 张`);
			const results = await Promise.all(accepted.map(compressImage));
			const ok = results.filter((v): v is string => Boolean(v));
			if (ok.length < results.length) setNotice("部分图片压缩失败，已跳过");
			setImages((prev) => [...prev, ...ok].slice(0, MAX_IMAGES));
			setBusy(false);
		})();
	};

	// 输入内容变化（含发送后清空）时自适应高度；只做 DOM 操作，不 setState
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
	}, [text]);

	const submit = () => {
		const trimmed = text.trim();
		if ((!trimmed && !images.length) || pending || busy) return;
		onSend(trimmed, images);
		setText("");
		setImages([]);
		setNotice(null);
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		// 技能菜单打开时，方向键/回车/Tab 归菜单用
		if (menuOpen) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setSkillIndex((i) => (i + 1) % matches.length);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setSkillIndex((i) => (i - 1 + matches.length) % matches.length);
				return;
			}
			if (event.key === "Enter" || event.key === "Tab") {
				event.preventDefault();
				pickSkill(matches[Math.min(skillIndex, matches.length - 1)]!.name);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setSkillMenu(null);
				return;
			}
		}
		// Enter 发送，Shift+Enter 换行；输入法选字确认的 Enter 不发送
		if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
			event.preventDefault();
			submit();
		}
	};

	/** 输入变化时判断是否要弹出技能菜单。 */
	const handleChange = (value: string, caret: number) => {
		setText(value);
		if (!skills.length) {
			setSkillMenu(null);
			return;
		}
		const token = detectSkillToken(value, caret);
		if (!token) {
			setSkillMenu(null);
			return;
		}
		setSkillMenu(token);
		setSkillIndex(0);
	};

	/** 点 ⚡：在光标处插入「/」并展开菜单。 */
	const openSkillMenu = () => {
		if (!skills.length) {
			setNotice("还没有安装技能，先在左侧 ⚡ 面板里添加。");
			return;
		}
		const el = textareaRef.current;
		const caret = el?.selectionStart ?? text.length;
		const before = text.slice(0, caret);
		const prefix = before && !/\s$/.test(before) ? " /" : "/";
		const next = `${before}${prefix}${text.slice(caret)}`;
		setText(next);
		setSkillMenu({ start: before.length + prefix.length - 1, query: "" });
		setSkillIndex(0);
		window.requestAnimationFrame(() => {
			const pos = before.length + prefix.length;
			el?.focus();
			el?.setSelectionRange(pos, pos);
		});
	};

	return (
		<div className="shrink-0 border-t border-slate-800 bg-slate-900/80 backdrop-blur">
			{(images.length > 0 || notice) && (
				<div className="mx-auto w-full max-w-3xl px-4 pt-2 sm:border-x sm:border-slate-800/60">
					{notice && <p className="mb-1 text-[11px] text-amber-300">{notice}</p>}
					<div className="flex flex-wrap gap-2">
						{images.map((src, index) => (
							<span key={`${src.slice(0, 32)}-${index}`} className="relative">
								<img src={src} alt={`待发送图片 ${index + 1}`} className="h-14 w-14 rounded-lg border border-slate-700 object-cover" />
								<button
									type="button"
									onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
									aria-label={`移除图片 ${index + 1}`}
									className="absolute -right-1 -top-1 h-4 w-4 rounded-full bg-slate-700 text-[10px] leading-none text-slate-100"
								>
									×
								</button>
							</span>
						))}
					</div>
				</div>
			)}
			<div className="relative mx-auto flex w-full max-w-3xl items-end gap-2 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3 sm:border-x sm:border-slate-800/60">
				{/* 技能菜单（v0.23.0）：输入 / 自动弹出 */}
				{menuOpen && (
					<div
						role="listbox"
						aria-label="选择技能"
						className="absolute bottom-full left-4 right-4 mb-1 max-h-64 overflow-y-auto rounded-xl border border-slate-700 bg-slate-900/95 p-1 shadow-2xl backdrop-blur"
					>
						<p className="px-2 py-1 text-[11px] text-slate-500">选择技能 · ↑↓ 选择，Enter 确认，Esc 取消</p>
						{matches.map((skill, index) => (
							<button
								key={skill.name}
								type="button"
								role="option"
								aria-selected={index === skillIndex}
								onMouseEnter={() => setSkillIndex(index)}
								onMouseDown={(e) => {
									e.preventDefault();
									pickSkill(skill.name);
								}}
								className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
									index === skillIndex ? "bg-sky-600/20 text-sky-100" : "text-slate-300 hover:bg-slate-800"
								}`}
							>
								<span aria-hidden className="mt-0.5 shrink-0 text-xs">
									⚡
								</span>
								<span className="min-w-0 flex-1">
									<span className="block truncate text-[13px] font-medium">{skill.name}</span>
									{skill.description && (
										<span className="block truncate text-[11px] text-slate-500">{skill.description}</span>
									)}
								</span>
							</button>
						))}
					</div>
				)}
				<button
					type="button"
					onClick={openSkillMenu}
					title="调用技能（也可以直接输入 /）"
					aria-label="调用技能"
					className="mb-1 h-[36px] w-[36px] shrink-0 rounded-lg border border-slate-700 text-slate-400 transition-colors hover:text-slate-100"
				>
					⚡
				</button>
				<button
					type="button"
					onClick={() => fileRef.current?.click()}
					disabled={busy || images.length >= MAX_IMAGES}
					title="添加图片"
					aria-label="添加图片"
					className="mb-1 h-[36px] w-[36px] shrink-0 rounded-lg border border-slate-700 text-slate-400 transition-colors hover:text-slate-100 disabled:opacity-40"
				>
					📎
				</button>
				<input
					ref={fileRef}
					type="file"
					accept="image/png,image/jpeg,image/webp"
					multiple
					hidden
					onChange={(event) => {
						if (event.target.files?.length) addFiles(event.target.files);
						event.target.value = "";
					}}
				/>
				<textarea
					ref={textareaRef}
					value={text}
					onChange={(event) => handleChange(event.target.value, event.target.selectionStart ?? event.target.value.length)}
					onClick={(event) => {
						// 点回已有文本时不误开菜单
						const el = event.currentTarget;
						if (skillMenu) setSkillMenu(detectSkillToken(el.value, el.selectionStart ?? 0));
					}}
					onBlur={() => setSkillMenu(null)}
					onKeyDown={handleKeyDown}
					onPaste={(event) => {
						const files = Array.from(event.clipboardData?.files ?? []);
						if (files.length) {
							event.preventDefault();
							addFiles(files);
						}
					}}
					rows={1}
					placeholder={pending ? "等待回复中…" : "输入消息，/ 调用技能，Enter 发送"}
					aria-label="消息输入框"
					className="min-h-[44px] flex-1 resize-none rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2.5 text-[16px] leading-relaxed text-slate-100 outline-none transition-colors placeholder:text-slate-500 focus:border-sky-500/70 focus:ring-1 focus:ring-sky-500/40"
				/>
				{pending ? (
					<button
						type="button"
						onClick={onStop}
						aria-label="停止等待本次回复"
						className="h-[44px] shrink-0 rounded-xl border border-slate-600 bg-slate-700 px-4 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-600"
					>
						停止
					</button>
				) : (
					<button
						type="button"
						onClick={submit}
						disabled={(!text.trim() && !images.length) || busy}
						className="h-[44px] shrink-0 rounded-xl bg-sky-600 px-4 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
					>
						发送
					</button>
				)}
			</div>
		</div>
	);
}
