import { Icon, type IconName } from "./Icon";

/** 左栏内容（不是弹窗）。 */
export type RailView = "sessions" | "files" | "shares" | "automations" | "users";
/** 走弹窗的三个入口（NERE-62）。与 RailView 不是同一维度，不要合并。 */
export type RailPanel = "kb" | "mcp" | "skills";

interface RailProps {
	view: RailView;
	/** 当前打开的弹窗；同一时刻最多一个。 */
	panel: RailPanel | null;
	onSelectView: (view: RailView) => void;
	/** 再点一次同一入口 = 关闭（幂等）。 */
	onTogglePanel: (panel: RailPanel) => void;
	onNewSession: () => void;
	newSessionDisabled?: boolean;
	onOpenSettings: () => void;
	/** 只有主人能看到用户管理（v0.43.0）。 */
	isOwner?: boolean;
	/** 分享清单接口是否已上线（NERE-56）：未上线时不渲染入口。 */
	sharesAvailable?: boolean;
	/** 分享未读数（NERE-74）：>0 时图标右上角显示圆点，读数只进 aria-label。 */
	sharesUnread?: number;
	/** 定时任务未读数（NERE-74）：成功 / 失败共用同一点位，状态由面板内的徽标区分。 */
	automationsUnread?: number;
}

const railButton =
	"flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 aria-pressed:bg-sky-500/15 aria-pressed:text-sky-300 aria-expanded:bg-sky-500/15 aria-expanded:text-sky-300";

/** 最左侧固定工具栏（v0.21.0）：新会话 + 会话/文件/分享/定时/用户 + 三个弹窗入口 + 设置。 */
export function Rail({ view, panel, onSelectView, onTogglePanel, onNewSession, newSessionDisabled, onOpenSettings, isOwner, sharesAvailable, sharesUnread = 0, automationsUnread = 0 }: RailProps) {
	/**
	 * 左栏内容入口。未读圆点（NERE-74）只是按钮里的一个装饰性 span：
	 * 不参与 tab 顺序、不进无障碍树，未读数通过 aria-label 播报。
	 */
	const item = (value: RailView, label: string, icon: IconName, unread = 0) => {
		const badge = unread > 0;
		return (
			<button
				key={value}
				type="button"
				onClick={() => onSelectView(value)}
				aria-pressed={view === value}
				title={badge ? `${label}（${unread} 条未读）` : label}
				aria-label={badge ? `${label}，${unread} 条未读` : label}
				className={`${railButton} relative`}
			>
				<Icon name={icon} className="h-[18px] w-[18px]" />
				{badge && (
					<span
						aria-hidden
						data-unread-dot={value}
						className="pointer-events-none absolute right-1 top-1 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-slate-950"
					/>
				)}
			</button>
		);
	};

	/** 弹窗入口：语义从「切换左栏」变成「打开对话框」（契约 §1.2）。 */
	const modalItem = (value: RailPanel, label: string, icon: IconName) => (
		<button
			key={value}
			type="button"
			onClick={() => onTogglePanel(value)}
			aria-haspopup="dialog"
			aria-expanded={panel === value}
			data-modal-trigger={value}
			title={label}
			aria-label={label}
			className={railButton}
		>
			<Icon name={icon} className="h-[18px] w-[18px]" />
		</button>
	);

	return (
		<nav
			aria-label="主导航"
			className="flex h-full w-12 shrink-0 flex-col items-center gap-1 border-r border-slate-800/70 bg-slate-950/40 py-2"
		>
			<button
				type="button"
				onClick={onNewSession}
				disabled={newSessionDisabled}
				title="新会话"
				aria-label="新建会话"
				className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-600/90 text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
			>
				<Icon name="plus" className="h-5 w-5" />
			</button>
			<div aria-hidden className="my-1 h-px w-6 bg-slate-800" />
			{item("sessions", "会话", "sessions")}
			{item("files", "全部文件", "folder")}
			{modalItem("kb", "知识库", "kb")}
			{sharesAvailable && item("shares", "分享", "share", sharesUnread)}
			{modalItem("mcp", "连接", "connection")}
			{item("automations", "定时", "clock", automationsUnread)}
			{modalItem("skills", "能力", "skills")}
			{isOwner && item("users", "用户", "users")}
			<div aria-hidden className="flex-1" />
			<button type="button" onClick={onOpenSettings} title="设置" aria-label="打开设置" className={railButton}>
				<Icon name="settings" className="h-[18px] w-[18px]" />
			</button>
		</nav>
	);
}
