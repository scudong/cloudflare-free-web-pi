/**
 * 弹窗外壳（NERE-62）：遮罩、尺寸、header / close、焦点圈、Esc、滚动锁、portal。
 *
 * 约束（契约 §2）：
 * - 只承载 UI，不出现 `api.` / `fetch(` / `"/api/`；
 * - 不做关闭动画，`open=false` 直接卸掉；
 * - 内容区不滚动（`min-h-0 flex-1`），滚动条归各面板自己。
 */

import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { FOCUSABLE_SELECTOR, nextFocusIndex } from "../lib/focus";
import { useMediaQuery } from "../lib/useMediaQuery";
import { Icon } from "./Icon";

export type ModalSize = "md" | "lg" | "xl";

/** 尺寸单点定义（契约 §3.2）：md = MCP / lg = 知识库 / xl = 技能。 */
export const MODAL_SIZE: Record<ModalSize, string> = {
	md: "w-[min(92vw,45rem)]",
	lg: "w-[min(92vw,55rem)]",
	xl: "w-[min(92vw,60rem)]",
};

/** 弹窗形态断点（与三栏布局的 DESKTOP_QUERY 无关）。 */
const SHEET_QUERY = "(max-width: 720px)";

// 模块级滚动锁计数：为将来「弹窗里再开一层」留出正确性（契约 §4.5）。
let lockCount = 0;
let overflowBeforeLock = "";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function focusableWithin(root: HTMLElement | null): HTMLElement[] {
	if (!root) return [];
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
		(element) => element.getClientRects().length > 0,
	);
}

export interface ModalShellProps {
	open: boolean;
	/** header 标题，同时作为 aria-labelledby 的文本来源（内部用 useId 生成 id）。 */
	title: string;
	/** md = 720px / lg = 880px / xl = 960px。 */
	size?: ModalSize;
	/** Esc、遮罩、关闭按钮都收敛到这一个回调。 */
	onClose: () => void;
	children: ReactNode;
	/** 可选底栏；不传则不渲染。 */
	footer?: ReactNode;
	/** 覆盖默认焦点落点（默认落到内容区第一个可聚焦元素）。 */
	initialFocusRef?: RefObject<HTMLElement | null>;
	/** 默认 true；导入进行中等场景可关掉防误触。 */
	closeOnScrim?: boolean;
	/** 供测试 / 端到端定位。 */
	testId?: string;
	/**
	 * 触发入口标识（"kb" / "mcp" / "skills"）：关闭时若原触发元素已卸载
	 * （移动端抽屉里的 Rail 会随抽屉关闭而卸载），用 `[data-modal-trigger]` 兜底回焦。
	 */
	triggerKey?: string;
}

export function ModalShell({
	open,
	title,
	size = "md",
	onClose,
	children,
	footer,
	initialFocusRef,
	closeOnScrim = true,
	testId,
	triggerKey,
}: ModalShellProps) {
	const isSheet = useMediaQuery(SHEET_QUERY);
	const titleId = useId();
	const dialogRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const closeRef = useRef<HTMLButtonElement>(null);
	const triggerRef = useRef<HTMLElement | null>(null);
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// 进入：记录触发元素、锁滚动、把 #root 移出可达树、落焦。
	useIsomorphicLayoutEffect(() => {
		if (!open) return;
		const active = document.activeElement;
		triggerRef.current = active instanceof HTMLElement ? active : null;

		if (lockCount === 0) {
			overflowBeforeLock = document.body.style.overflow;
			document.body.style.overflow = "hidden";
		}
		lockCount += 1;

		const root = document.getElementById("root");
		root?.setAttribute("aria-hidden", "true");
		root?.setAttribute("inert", "");

		const firstInContent = focusableWithin(contentRef.current)[0];
		const target = initialFocusRef?.current ?? firstInContent ?? closeRef.current;
		target?.focus();

		return () => {
			lockCount -= 1;
			if (lockCount === 0) document.body.style.overflow = overflowBeforeLock;
			root?.removeAttribute("aria-hidden");
			root?.removeAttribute("inert");

			const trigger = triggerRef.current;
			const fallback = triggerKey ? document.querySelector<HTMLElement>(`[data-modal-trigger="${triggerKey}"]`) : null;
			const back = trigger?.isConnected ? trigger : fallback;
			back?.focus();
		};
		// 只跟随 open：回调变化不应触发一次「回焦 + 再落焦」。
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// Esc：document capture，命中即阻断，避免分享 / 设置弹窗同时被关掉（契约 §4.1）。
	useEffect(() => {
		if (!open) return;
		const onKey = (event: globalThis.KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			onCloseRef.current();
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [open]);

	const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "Tab") return;
		const items = focusableWithin(dialogRef.current);
		if (items.length === 0) {
			event.preventDefault();
			return;
		}
		const current = document.activeElement instanceof HTMLElement ? items.indexOf(document.activeElement) : -1;
		const next = nextFocusIndex(event.shiftKey ? -1 : 1, current, items.length);
		if (next < 0) return;
		event.preventDefault();
		items[next]?.focus();
	};

	if (!open) return null;

	const dialog = (
		<div
			className={isSheet ? "fixed inset-0 z-40" : "fixed inset-0 z-40 flex items-center justify-center p-4"}
			data-testid={testId}
		>
			{/* 遮罩用按钮：键盘用户也能点到，且不需额外 tabIndex。 */}
			<button
				type="button"
				aria-label="关闭弹窗"
				onClick={() => {
					if (closeOnScrim) onClose();
				}}
				className="dialog-scrim absolute inset-0"
			/>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				onKeyDown={handleKeyDown}
				className={`modal-card relative flex flex-col overflow-hidden border border-slate-700 bg-slate-900 shadow-2xl ${
					isSheet
						? "h-[100dvh] w-screen rounded-none pb-[env(safe-area-inset-bottom)]"
						: `max-h-[90vh] rounded-2xl ${MODAL_SIZE[size]}`
				}`}
			>
				<header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800/70 px-5 py-3">
					<h2 id={titleId} className="text-sm font-semibold text-slate-100">
						{title}
					</h2>
					<button
						ref={closeRef}
						type="button"
						onClick={onClose}
						aria-label="关闭"
						className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-white max-[720px]:h-11 max-[720px]:w-11"
					>
						<Icon name="close" className="h-4 w-4" />
					</button>
				</header>

				{/* 内容区不滚动：Shell 给 min-h-0 flex-1，滚动条归面板。 */}
				<div ref={contentRef} className="flex min-h-0 flex-1 flex-col">
					{children}
				</div>

				{footer && <footer className="shrink-0 border-t border-slate-800/70 px-5 py-3">{footer}</footer>}
			</div>
		</div>
	);

	// SSR（renderToStaticMarkup）没有 document：就地渲染，不做 portal。
	return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
