import {
	Archive,
	BookOpen,
	Brain,
	BrainCircuit,
	Check,
	ChevronDown,
	ChevronRight,
	ChevronsLeft,
	ChevronsRight,
	Circle,
	CircleCheck,
	CircleX,
	Clock,
	Cpu,
	Database,
	Download,
	ExternalLink,
	FileText,
	FolderOpen,
	GitBranch,
	Globe,
	GripHorizontal,
	HardDriveDownload,
	Link2,
	ListChecks,
	LoaderCircle,
	Maximize2,
	Menu,
	MessageCircleQuestion,
	MessageSquare,
	MessageSquareText,
	Minimize2,
	Moon,
	MoonStar,
	Paperclip,
	Pencil,
	Plug,
	Plus,
	Puzzle,
	RotateCcw,
	Ruler,
	ScrollText,
	Settings,
	ShieldAlert,
	Sparkles,
	Square,
	SquareCheckBig,
	Sun,
	Target,
	TextQuote,
	Trash2,
	Upload,
	Users,
	Wrench,
	X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * 全站图标语义表（v0.39.0）。
 * 统一 24 网格线性图标、1.75 描边、currentColor —— 颜色由外层文字色决定，
 * 与现有 slate / sky / emerald / amber / violet 色系一致。
 */
const ICONS = {
	menu: Menu,
	settings: Settings,
	plus: Plus,
	sessions: MessageSquareText,
	chat: MessageSquare,
	connection: Plug,
	clock: Clock,
	skills: Sparkles,
	file: FileText,
	folder: FolderOpen,
	kb: BookOpen,
	trash: Trash2,
	edit: Pencil,
	branch: GitBranch,
	close: X,
	share: Link2,
	external: ExternalLink,
	chevronsLeft: ChevronsLeft,
	chevronsRight: ChevronsRight,
	maximize: Maximize2,
	restoreSize: Minimize2,
	goal: Target,
	plan: ListChecks,
	check: Check,
	done: CircleCheck,
	circle: Circle,
	loader: LoaderCircle,
	error: CircleX,
	thinking: Brain,
	memory: BrainCircuit,
	tool: Wrench,
	approval: ShieldAlert,
	question: MessageCircleQuestion,
	attach: Paperclip,
	upload: Upload,
	link: Link2,
	download: Download,
	backup: HardDriveDownload,
	restore: RotateCcw,
	globe: Globe,
	puzzle: Puzzle,
	prompt: TextQuote,
	rule: Ruler,
	model: Cpu,
	data: Database,
	chevronDown: ChevronDown,
	chevronRight: ChevronRight,
	themeDark: Moon,
	themeLight: Sun,
	themeSepia: ScrollText,
	themeMidnight: MoonStar,
	checkboxOn: SquareCheckBig,
	checkboxOff: Square,
	subagent: Users,
	users: Users,
	grip: GripHorizontal,
	compact: Archive,
} as const satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

interface IconProps {
	name: IconName;
	className?: string;
	strokeWidth?: number;
	/** 有独立语义时传 label；默认按装饰图标隐藏。 */
	label?: string;
}

/** 统一图标入口：尺寸/颜色由 className 控制，描边默认 1.75。 */
export function Icon({ name, className = "h-4 w-4", strokeWidth = 1.75, label }: IconProps) {
	const Component = ICONS[name];
	return (
		<Component
			className={className}
			strokeWidth={strokeWidth}
			aria-hidden={label ? undefined : true}
			aria-label={label}
			role={label ? "img" : undefined}
		/>
	);
}
