/**
 * useSettingsData（NERE-81）：设置弹窗的全部服务端读写。
 *
 * 分层约束（ADR-0002）：`api.*` 只出现在 hooks 层。SettingsDialog 以前把 16 处调用
 * 散在多个 Section 里，页面层无法判断「打开设置会不会打接口」；这里按资源拆成几个
 * 内部 hook，再由 `useSettingsData` 汇总成一个返回值：
 * - 部署自检：providers / models / kbStatus / version（`kbRetrieval` 直接吃 bootstrap）；
 * - pi 内核版本、知识库索引状态、工具清单、供应商、手动压缩；
 * - 分享署名与默认有效期不在这里：它们在 App 里属于 bootstrap 的 `settings` 面板。
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";

export type SettingsTab = "general" | "chat" | "model" | "memory" | "data";

type ProviderInfo = {
	id: string;
	name: string;
	baseUrl: string;
	models: string[];
	keyHint?: string;
	active?: boolean;
};

export type CheckState = "loading" | "ok" | "warning" | "error";

export type DeploymentCheckRow = {
	label: string;
	state: CheckState;
	detail: string;
	fix?: string;
};

type KernelInfo = {
	current?: Record<string, string>;
	latest?: Record<string, string>;
	checkedAt?: string;
	updateAvailable?: boolean;
	outdated?: string[];
	upgrade?: { manual?: string; auto?: string };
};

export type KbIndexStatus = { mode?: string; available?: boolean; index?: string; total?: number; indexed?: number };

export type ToolPolicyRow = { name: string; category: string; policy: string; override: string };

export type ProviderForm = { id?: string; name: string; baseUrl: string; apiKey: string; models: string };

/** 部署自检：只在「通用」tab 打开时跑一组只读探测。 */
function useDeploymentCheck(open: boolean, tab: SettingsTab, kbRetrieval: string) {
	const [rows, setRows] = useState<DeploymentCheckRow[]>([]);
	const [checking, setChecking] = useState(false);

	const check = useCallback(async () => {
		setChecking(true);
		setRows([
			{ label: "模型密钥", state: "loading", detail: "正在检查…" },
			{ label: "模型供应商", state: "loading", detail: "正在检查…" },
			{ label: "知识库检索", state: "loading", detail: "正在检查…" },
			{ label: "分享域名", state: "loading", detail: "正在检查…" },
			{ label: "线上构建号", state: "loading", detail: "正在检查…" },
		]);

		const [providers, models, kb, version] = await Promise.allSettled([
			api.providers(),
			api.models(),
			api.kbStatus(),
			api.version(),
		]);
		const providerData = providers.status === "fulfilled" ? providers.value : null;
		const modelData = models.status === "fulfilled" ? models.value : null;
		const kbData = kb.status === "fulfilled" ? kb.value : null;
		const versionData = version.status === "fulfilled" ? version.value : null;
		const activeId = providerData?.active || modelData?.provider || providerData?.default?.id || "";
		const customProvider = providerData?.providers?.find((provider) => provider.id === activeId);
		const defaultProvider = !customProvider && providerData?.default?.id === activeId ? providerData.default : null;
		// `hasKey` 是已有 providers 响应在可提供时的非敏感布尔值；绝不读取或展示密钥本身。
		const hasKey = customProvider?.hasKey ?? defaultProvider?.hasKey;
		const providerReachable = Boolean(providerData && modelData && activeId);
		// 检索模式用页面层已有的 bootstrap 设置，不再单独拉一次 /api/settings。
		const kbMode = kbRetrieval || kbData?.mode;
		const kbReady = Boolean(kbData && (kbMode === "fts" || kbData.available));
		const origin = typeof window === "undefined" ? "" : window.location.origin;
		const build = versionData?.build?.trim() ?? "";

		setRows([
			{
				label: "模型密钥",
				state: hasKey === false ? "warning" : hasKey === true ? "ok" : providerData ? "warning" : "error",
				detail:
					hasKey === false
						? "未配置 DeepSeek API Key。"
						: hasKey === true
							? "已配置，密钥不会在浏览器中显示。"
							: providerData
								? "默认供应商未返回密钥状态，请在本地或部署配置中确认。"
								: "无法读取模型配置。",
				fix: hasKey === false || hasKey === undefined ? "npx wrangler secret put DEEPSEEK_API_KEY" : undefined,
			},
			{
				label: "模型供应商",
				state: providerReachable ? "ok" : "error",
				detail: providerReachable ? `当前使用 ${activeId}。` : "模型供应商接口不可用。",
				fix: providerReachable ? undefined : "在设置 → 模型中配置供应商后重试。",
			},
			{
				label: "知识库检索",
				state: kbReady ? "ok" : kbData ? "warning" : "error",
				detail: kbReady ? `检索模式：${kbMode ?? "fts"}。` : kbData ? "向量检索绑定未启用。" : "无法读取知识库状态。",
				fix: kbReady ? undefined : "检查 AI / KB_VEC 绑定，或在设置中切换为 FTS。",
			},
			{
				label: "分享域名",
				state: origin ? "ok" : "error",
				detail: origin ? `公开链接将使用 ${origin}。` : "无法识别当前站点域名。",
			},
			{
				label: "线上构建号",
				state: build && build !== "dev" ? "ok" : build ? "warning" : "error",
				detail: build ? (build === "dev" ? "当前为本地开发构建。" : `SHA：${build.slice(0, 7)}。`) : "无法读取构建号。",
				fix: build && build !== "dev" ? undefined : "重新部署后确认 BUILD 注入了当前提交 SHA。",
			},
		]);
		setChecking(false);
	}, [kbRetrieval]);

	useEffect(() => {
		if (!open || tab !== "general") return;
		void check();
	}, [open, tab, check]);

	return { rows, checking, recheck: check };
}

/** pi 内核版本：打开设置时读一次（走 6 小时缓存）。 */
function useKernelInfo(open: boolean) {
	const [kernel, setKernel] = useState<KernelInfo | null>(null);
	const [kernelBusy, setKernelBusy] = useState(false);

	const loadKernel = async (refresh: boolean) => {
		setKernelBusy(true);
		try {
			setKernel(await api.kernel(refresh));
		} catch {
			setKernel(null);
		} finally {
			setKernelBusy(false);
		}
	};

	useEffect(() => {
		if (!open) return;
		let alive = true;
		void (async () => {
			try {
				const data = await api.kernel(false);
				if (alive) setKernel(data);
			} catch {
				// 接口不可用时保持空
			}
		})();
		return () => {
			alive = false;
		};
	}, [open]);

	return { kernel, kernelBusy, loadKernel };
}

/** 手动压缩：只在「对话」tab 里由按钮触发。 */
function useCompaction(sessionId: string) {
	const [compactState, setCompactState] = useState<"idle" | "running" | "done" | "error">("idle");
	const [compactMessage, setCompactMessage] = useState("");

	const compactNow = async () => {
		setCompactState("running");
		setCompactMessage("");
		try {
			const res = await api.compact(sessionId);
			if (res.error) {
				setCompactState("error");
				setCompactMessage(res.error);
			} else {
				setCompactState("done");
				setCompactMessage("已提交压缩任务，完成后聊天里会出现提示。");
			}
		} catch (err) {
			setCompactState("error");
			setCompactMessage(err instanceof Error ? err.message : String(err));
		}
	};

	return { compactState, compactMessage, compactNow };
}

/** 知识库向量索引状态（「对话」tab）。 */
function useKbIndexStatus(open: boolean, tab: SettingsTab) {
	const [kbStatus, setKbStatus] = useState<KbIndexStatus | null>(null);
	const [kbReindexBusy, setKbReindexBusy] = useState(false);
	const [kbReindexMessage, setKbReindexMessage] = useState("");

	useEffect(() => {
		if (!open || tab !== "chat") return;
		let alive = true;
		void (async () => {
			try {
				const data = await api.kbStatus();
				if (alive) setKbStatus(data);
			} catch {
				if (alive) setKbStatus(null);
			}
		})();
		return () => {
			alive = false;
		};
	}, [open, tab]);

	const reindexKb = () => {
		if (kbReindexBusy) return;
		setKbReindexBusy(true);
		setKbReindexMessage("");
		void (async () => {
			try {
				const data = await api.kbReindex();
				if (data.error) throw new Error(data.error);
				const remaining = Number(data.remaining ?? 0);
				setKbReindexMessage(
					`已索引 ${data.indexed ?? 0} 段${remaining > 0 ? `，剩余 ${remaining} 段，再点一次继续` : "，全部完成"}`,
				);
				setKbStatus(await api.kbStatus());
			} catch (err) {
				setKbReindexMessage(err instanceof Error ? err.message : String(err));
			} finally {
				setKbReindexBusy(false);
			}
		})();
	};

	return { kbStatus, kbReindexBusy, kbReindexMessage, reindexKb };
}

/** 工具清单（「对话」tab）：逐工具审批覆盖的选择项。 */
function useToolList(open: boolean, tab: SettingsTab) {
	const [toolList, setToolList] = useState<ToolPolicyRow[]>([]);

	useEffect(() => {
		if (!open || tab !== "chat") return;
		let alive = true;
		void (async () => {
			try {
				const data = await api.tools();
				if (alive && Array.isArray(data.tools)) setToolList(data.tools);
			} catch {
				// 接口不可用时保持空列表
			}
		})();
		return () => {
			alive = false;
		};
	}, [open, tab]);

	return { toolList, setToolList };
}

/** 供应商（「模型」tab）：列表 / 启用 / 新增 / 编辑 / 删除。 */
function useProviders(open: boolean, tab: SettingsTab, onModelsChanged?: () => void) {
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [defaultProvider, setDefaultProvider] = useState<{ id: string; name: string; models: string[] } | null>(null);
	const [activeProvider, setActiveProvider] = useState("");
	const [providersLoading, setProvidersLoading] = useState(false);
	const [providerError, setProviderError] = useState<string | null>(null);
	const [providerBusy, setProviderBusy] = useState(false);
	const [form, setForm] = useState<ProviderForm | null>(null);

	const loadProviders = async () => {
		setProvidersLoading(true);
		try {
			const data = await api.providers();
			setProviders(Array.isArray(data.providers) ? data.providers : []);
			setDefaultProvider(data.default ?? null);
			setActiveProvider(data.active ?? "");
			setProviderError(null);
		} catch (err) {
			setProviderError(err instanceof Error ? err.message : String(err));
		} finally {
			setProvidersLoading(false);
		}
	};

	useEffect(() => {
		if (open && tab === "model") void loadProviders();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, tab]);

	const activateProvider = async (id: string) => {
		if (providerBusy) return;
		setProviderBusy(true);
		try {
			await api.activateProvider(id);
			await loadProviders();
			onModelsChanged?.();
		} catch (err) {
			setProviderError(err instanceof Error ? err.message : String(err));
		} finally {
			setProviderBusy(false);
		}
	};

	const saveProvider = async () => {
		if (!form || providerBusy) return;
		setProviderBusy(true);
		try {
			await api.saveProvider({
				id: form.id,
				name: form.name,
				baseUrl: form.baseUrl,
				apiKey: form.apiKey,
				models: form.models,
			});
			setForm(null);
			await loadProviders();
			onModelsChanged?.();
		} catch (err) {
			setProviderError(err instanceof Error ? err.message : String(err));
		} finally {
			setProviderBusy(false);
		}
	};

	const removeProvider = async (id: string, name: string) => {
		if (!window.confirm(`删除供应商「${name}」？`)) return;
		setProviderBusy(true);
		try {
			await api.deleteProvider(id);
			await loadProviders();
			onModelsChanged?.();
		} catch (err) {
			setProviderError(err instanceof Error ? err.message : String(err));
		} finally {
			setProviderBusy(false);
		}
	};

	return {
		providers,
		defaultProvider,
		activeProvider,
		providersLoading,
		providerError,
		providerBusy,
		form,
		setForm,
		activateProvider,
		saveProvider,
		removeProvider,
	};
}

export function useSettingsData({
	open,
	tab,
	sessionId,
	kbRetrieval,
	onModelsChanged,
}: {
	open: boolean;
	tab: SettingsTab;
	sessionId: string;
	/** bootstrap 里已有的检索模式：部署自检不再单独请求 /api/settings。 */
	kbRetrieval: string;
	onModelsChanged?: () => void;
}) {
	const deployment = useDeploymentCheck(open, tab, kbRetrieval);
	const kernel = useKernelInfo(open);
	const compaction = useCompaction(sessionId);
	const kbIndex = useKbIndexStatus(open, tab);
	const tools = useToolList(open, tab);
	const providers = useProviders(open, tab, onModelsChanged);

	return { deployment, kernel, compaction, kbIndex, tools, providers };
}
