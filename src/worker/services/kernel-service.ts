// 构建期注入：内核依赖版本（v0.35.0）
import packageJson from "../../../package.json";
import type { SettingsPort } from "../http/ports";

/**
 * pi 内核版本（v0.35.0）：声明版本 + npm 最新版本（缓存 6 小时）。
 * 外部 HTTP 与缓存编排在 Service；响应形状与旧 `GET /kernel` 逐字一致。
 */
export const PI_PACKAGES = [
	"@earendil-works/pi-durable",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-mcp",
	"@earendil-works/pi-codemode",
];

export type KernelSettings = SettingsPort & { set(key: string, value: string): void };

export type KernelInfo = {
	current: Record<string, string>;
	latest: Record<string, string>;
	checkedAt: string;
	updateAvailable: boolean;
	outdated: string[];
	upgrade: { manual: string; auto: string };
};

/** package.json 里声明的版本范围（构建期内联）。 */
export function declaredKernelVersions(): Record<string, string> {
	const deps = (packageJson as { dependencies?: Record<string, string> }).dependencies ?? {};
	const out: Record<string, string> = {};
	for (const name of PI_PACKAGES) out[name] = deps[name] ?? "(传递依赖)";
	return out;
}

/** 去掉 ^ ~ 等前缀，得到可比较的数字段。 */
function semverParts(v: string): number[] {
	return v
		.replace(/^[^0-9]*/, "")
		.split("-")[0]!
		.split(".")
		.map((n) => Number(n) || 0);
}

/** a 是否比 b 新（逐段比较）。 */
function semverGreater(a: string, b: string): boolean {
	const pa = semverParts(a);
	const pb = semverParts(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x !== y) return x > y;
	}
	return false;
}

/** 查 npm 上的最新版本；失败返回 null（不阻塞页面）。 */
async function fetchLatestVersion(name: string, fetchImpl: typeof fetch): Promise<string | null> {
	try {
		const res = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { version?: unknown };
		return typeof data.version === "string" ? data.version : null;
	} catch {
		return null;
	}
}

export async function kernelInfo(
	{ settings, refresh = false, fetchImpl = fetch }: { settings: KernelSettings; refresh?: boolean; fetchImpl?: typeof fetch },
): Promise<KernelInfo> {
	const current = declaredKernelVersions();
	const cachedAt = settings.get("kernel_checked_at", "");
	const fresh = cachedAt !== "" && Date.now() - new Date(cachedAt).getTime() < 6 * 3600_000;
	let latest: Record<string, string> = {};
	try {
		latest = JSON.parse(settings.get("kernel_latest", "{}")) as Record<string, string>;
	} catch {
		latest = {};
	}
	let checkedAt = cachedAt;
	if (refresh || !fresh) {
		const results = await Promise.all(PI_PACKAGES.map(async (name) => [name, await fetchLatestVersion(name, fetchImpl)] as const));
		latest = {};
		for (const [name, version] of results) if (version) latest[name] = version;
		checkedAt = new Date().toISOString();
		if (Object.keys(latest).length) {
			settings.set("kernel_latest", JSON.stringify(latest));
			settings.set("kernel_checked_at", checkedAt);
		}
	}
	// 只比较声明了版本的包；传递依赖不计入「可升级」
	const outdated = PI_PACKAGES.filter(
		(name) => latest[name] && /\d/.test(current[name] ?? "") && semverGreater(latest[name]!, current[name]!),
	);
	return {
		current,
		latest,
		checkedAt,
		updateAvailable: outdated.length > 0,
		outdated,
		upgrade: {
			manual: "npm run upgrade:pi",
			auto: "每周一 09:00 UTC 自动检查并开 PR（.github/workflows/pi-upgrade.yml），也可在 Actions 里手动触发",
		},
	};
}
