import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { KnowledgePanel } from "../../src/web/components/KnowledgePanel";
import { McpPanel } from "../../src/web/components/McpPanel";
import { SkillPanel } from "../../src/web/components/SkillPanel";
import { MODAL_SIZE, ModalShell } from "../../src/web/components/ModalShell";
import { Rail } from "../../src/web/components/Rail";
import { nextFocusIndex } from "../../src/web/lib/focus";

const noop = () => {};

describe("nextFocusIndex（契约 §4.3）", () => {
	it("没有可聚焦元素时返回 -1", () => {
		expect(nextFocusIndex(1, -1, 0)).toBe(-1);
		expect(nextFocusIndex(-1, 0, 0)).toBe(-1);
	});

	it("只有一个元素时 Tab / Shift+Tab 都停在它身上", () => {
		expect(nextFocusIndex(1, 0, 1)).toBe(0);
		expect(nextFocusIndex(-1, 0, 1)).toBe(0);
	});

	it("多个元素时首尾循环", () => {
		expect(nextFocusIndex(1, 0, 3)).toBe(1);
		expect(nextFocusIndex(1, 2, 3)).toBe(0);
		expect(nextFocusIndex(-1, 0, 3)).toBe(2);
		expect(nextFocusIndex(-1, 2, 3)).toBe(1);
	});

	it("焦点不在圈内时落到两端", () => {
		expect(nextFocusIndex(1, -1, 3)).toBe(0);
		expect(nextFocusIndex(-1, -1, 3)).toBe(2);
	});
});

describe("ModalShell 尺寸映射（契约 §3.2）", () => {
	it("md / lg / xl 单点定义，与契约尺寸一致", () => {
		expect(MODAL_SIZE.md).toContain("45rem");
		expect(MODAL_SIZE.lg).toContain("55rem");
		expect(MODAL_SIZE.xl).toContain("60rem");
	});
});

describe("ModalShell SSR 标记（契约 §4.4 / §10）", () => {
	it("open=false 直接不渲染", () => {
		const html = renderToStaticMarkup(
			<ModalShell open={false} title="知识库" onClose={noop}>
				<p>内容</p>
			</ModalShell>,
		);
		expect(html).toBe("");
	});

	it("role / aria-modal / aria-labelledby 指向真实标题 id", () => {
		const html = renderToStaticMarkup(
			<ModalShell open title="知识库" size="lg" onClose={noop} testId="kb-modal">
				<p>内容</p>
			</ModalShell>,
		);
		expect(html).toContain('role="dialog"');
		expect(html).toContain('aria-modal="true"');
		expect(html).toContain('data-testid="kb-modal"');
		expect(html).toContain("知识库");
		expect(html).toContain("内容");
		expect(html).toContain(MODAL_SIZE.lg);

		const labelledBy = /aria-labelledby="([^"]+)"/.exec(html)?.[1];
		expect(labelledBy).toBeTruthy();
		expect(html).toContain(`<h2 id="${labelledBy}"`);
	});

	it("只新增 ModalShell 一处 role=dialog / aria-modal（三个面板自己不声明）", () => {
		const shell = renderToStaticMarkup(
			<ModalShell open title="技能" size="xl" onClose={noop}>
				<p>内容</p>
			</ModalShell>,
		);
		expect((shell.match(/role="dialog"/g) ?? []).length).toBe(1);

		const kb = renderToStaticMarkup(<KnowledgePanel onClose={noop} />);
		const mcp = renderToStaticMarkup(
			<McpPanel servers={[]} loading={false} error={null} onAdd={async () => true} onDelete={async () => true} onClose={noop} />,
		);
		const skills = renderToStaticMarkup(
			<SkillPanel
				items={[]}
				loading={false}
				error={null}
				onAdd={async () => true}
				onDelete={async () => true}
				onImport={async () => ({ ok: true })}
				onTry={noop}
				prompts={[]}
				rules={[]}
				onAddPrompt={async () => true}
				onDeletePrompt={async () => true}
				onAddRule={async () => true}
				onToggleRule={async () => true}
				onDeleteRule={async () => true}
				customTools={[]}
				onAddCustomTool={async () => true}
				onDeleteCustomTool={async () => true}
				onClose={noop}
			/>,
		);
		for (const html of [kb, mcp, skills]) {
			expect(html).not.toContain('role="dialog"');
			expect(html).not.toContain("aria-modal");
		}
	});
});

describe("Rail 弹窗入口语义（契约 §1.2）", () => {
	const html = renderToStaticMarkup(
		<Rail
			view="sessions"
			panel="kb"
			onSelectView={noop}
			onTogglePanel={noop}
			onNewSession={noop}
			onOpenSettings={noop}
			sharesAvailable
			isOwner
		/>,
	);

	it("三个入口带 aria-haspopup=dialog 与 data-modal-trigger", () => {
		expect(html).toContain('aria-haspopup="dialog"');
		for (const panel of ["kb", "mcp", "skills"]) {
			expect(html).toContain(`data-modal-trigger="${panel}"`);
		}
	});

	it("只有当前打开的入口 aria-expanded=true", () => {
		expect((html.match(/aria-expanded="true"/g) ?? []).length).toBe(1);
		expect((html.match(/aria-expanded="false"/g) ?? []).length).toBe(2);
	});

	it("左栏内容入口仍用 aria-pressed", () => {
		expect((html.match(/aria-pressed="/g) ?? []).length).toBe(5);
	});
});
