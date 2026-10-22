/**
 * useSkillHub（NERE-54）：Skill Hub 列表的唯一读取者。
 *
 * - 进入 Hub 视图时取一次；筛选变化时带查询串重取（q 防抖 250ms），只有最后一次请求能落地。
 * - 服务端可能忽略筛选参数，所以本地再过滤一遍；两边都过滤时结果一致。
 * - tag / source 下拉的选项优先用响应的 `filters`（契约 §5.2），并与历史响应取并集，
 *   避免服务端过滤后选项自己塌掉。
 * - 远程目录刷新失败时响应仍是 200 + `catalog.stale=true`：列表照常展示，只提示可能过期。
 * - 请求失败保留上一份数据并给可重试的错误；首次失败就是错误态，不会无限 loading。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import {
	filterHubSkills,
	parseHubPage,
	sortHubSkills,
	sourceHost,
	type SkillHubCatalog,
	type SkillHubFilters,
} from "../lib/skill-hub";
import type { SkillHubEntry } from "../types";

export interface SkillHubFacets {
	tags: string[];
	/** host，不是完整 URL。 */
	sources: string[];
}

export interface SkillHubState {
	/** 当前筛选后的条目（已按 audit 优先排序）。 */
	items: SkillHubEntry[];
	/** 下拉选项：响应 `filters` 与历史出现过的 tag / source 并集。 */
	facets: SkillHubFacets;
	/** 远程目录刷新失败（契约 §5.2）：列表可用，但可能过期。 */
	catalogStale: boolean;
	status: "loading" | "ready" | "error";
	/** 最近一次失败原因（有旧数据时仍保留清单）。 */
	error: string | null;
	/** 服务端返回的匹配总数（可能大于当前页）。 */
	total: number;
	/** 最近一次响应里的条目数：区分「首次加载」与「筛选后为空」。 */
	rawCount: number;
	reload: () => void;
}

function union(previous: readonly string[], next: readonly string[]): string[] {
	const seen = new Set(previous);
	for (const item of next) seen.add(item);
	return [...seen].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

export function useSkillHub(filters: SkillHubFilters): SkillHubState {
	const [all, setAll] = useState<SkillHubEntry[]>([]);
	const [status, setStatus] = useState<SkillHubState["status"]>("loading");
	const [error, setError] = useState<string | null>(null);
	const [catalog, setCatalog] = useState<SkillHubCatalog | null>(null);
	const [total, setTotal] = useState(0);
	const [facets, setFacets] = useState<SkillHubFacets>({ tags: [], sources: [] });
	const [debouncedQuery, setDebouncedQuery] = useState(filters.q);
	/** 请求序号：筛选快速切换时丢弃过期响应。 */
	const requestRef = useRef(0);
	const facetsRef = useRef<SkillHubFacets>({ tags: [], sources: [] });

	useEffect(() => {
		const timer = setTimeout(() => setDebouncedQuery(filters.q), 250);
		return () => clearTimeout(timer);
	}, [filters.q]);

	const load = useCallback(async () => {
		const request = ++requestRef.current;
		setStatus("loading");
		setError(null);
		try {
			const response = await api.skillHub({
				q: debouncedQuery,
				runtime: filters.runtime,
				tag: filters.tag,
				audit: filters.audit,
				source: filters.source,
			});
			if (request !== requestRef.current) return;
			const page = parseHubPage(response);
			setAll(page.entries);
			setTotal(page.total);
			setCatalog(page.catalog);
			const derivedTags = page.entries.flatMap((entry) => entry.tags);
			const derivedSources = page.entries.map((entry) => sourceHost(entry.source)).filter(Boolean);
			const mergedFacets: SkillHubFacets = {
				tags: union(facetsRef.current.tags, page.options.tags.length > 0 ? page.options.tags : derivedTags),
				sources: union(
					facetsRef.current.sources,
					page.options.sources.length > 0 ? page.options.sources : derivedSources,
				),
			};
			facetsRef.current = mergedFacets;
			setFacets(mergedFacets);
			setStatus("ready");
		} catch (err) {
			if (request !== requestRef.current) return;
			setError(err instanceof Error && err.message ? err.message : "未知错误");
			setStatus("error");
		}
	}, [debouncedQuery, filters.runtime, filters.tag, filters.audit, filters.source]);

	// 0ms 延时让 StrictMode 的重复挂载在第一轮被清理掉，只发一次请求。
	useEffect(() => {
		const timer = setTimeout(() => void load(), 0);
		return () => clearTimeout(timer);
	}, [load]);

	const reload = useCallback(() => {
		void load();
	}, [load]);

	const items = useMemo(
		() => sortHubSkills(filterHubSkills(all, filters)),
		// 逐字段依赖：调用方每次渲染重建 filters 对象时不用重算。
		[all, filters.q, filters.runtime, filters.tag, filters.audit, filters.source],
	);

	return {
		items,
		facets,
		catalogStale: catalog?.stale === true,
		status,
		error,
		total,
		rawCount: all.length,
		reload,
	};
}
