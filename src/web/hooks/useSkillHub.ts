/**
 * useSkillHub（NERE-54）：Skill Hub 列表的唯一读取者。
 *
 * - 进入 Hub 视图时取一次；筛选变化时带查询串重取（q 防抖 250ms），只有最后一次请求能落地。
 * - 服务端可能忽略筛选参数，所以本地再过滤一遍；两边都过滤时结果一致。
 * - tag / source 下拉的选项从历史响应里累积（取并集），避免服务端过滤后选项自己塌掉。
 * - 失败保留上一份数据并给可重试的错误；首次失败就是错误态，不会无限 loading。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import {
	filterHubSkills,
	parseHubSkills,
	sortHubSkills,
	type SkillHubFilters,
} from "../lib/skill-hub";
import type { SkillHubEntry } from "../types";

export interface SkillHubFacets {
	tags: string[];
	sources: string[];
}

export interface SkillHubState {
	/** 当前筛选后的条目（已按 audit 优先排序）。 */
	items: SkillHubEntry[];
	/** 下拉选项：历史响应里出现过的 tag / source。 */
	facets: SkillHubFacets;
	status: "loading" | "ready" | "error";
	/** 最近一次失败原因（有旧数据时仍保留清单）。 */
	error: string | null;
	/** 未经筛选的响应条数：区分「首次加载」与「筛选后为空」。 */
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
			});
			if (request !== requestRef.current) return;
			const entries = parseHubSkills(response);
			setAll(entries);
			const mergedFacets: SkillHubFacets = {
				tags: union(facetsRef.current.tags, entries.flatMap((entry) => entry.tags)),
				sources: union(facetsRef.current.sources, entries.map((entry) => entry.source).filter(Boolean)),
			};
			facetsRef.current = mergedFacets;
			setFacets(mergedFacets);
			setStatus("ready");
		} catch (err) {
			if (request !== requestRef.current) return;
			setError(err instanceof Error && err.message ? err.message : "未知错误");
			setStatus("error");
		}
	}, [debouncedQuery, filters.runtime, filters.tag, filters.audit]);

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

	return { items, facets, status, error, rawCount: all.length, reload };
}
