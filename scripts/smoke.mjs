#!/usr/bin/env node
/**
 * 线上冒烟测试（v0.37.1）
 *
 * 部署后跑一遍，确认「部署了但功能是坏的」这类问题能被立刻发现
 * （比如审批那次包装层漏参数，接口都通、codemode 全挂）。
 *
 * 用法：
 *   npm run smoke              # 接口层
 *   npm run smoke -- --deep    # 额外跑一次真实对话，验证工具执行链路
 *
 * 密码来源：环境变量 PI_PASSWORD，或 macOS 钥匙串
 *   security find-generic-password -a pi-harness -s pi-harness-access -w
 * 站点：PI_BASE，默认 https://pi-harness-gw.pages.dev
 */

import { execSync } from "node:child_process";

const BASE = process.env.PI_BASE || "https://pi-harness-gw.pages.dev";
const DEEP = process.argv.includes("--deep");

function readPassword() {
	if (process.env.PI_PASSWORD) return process.env.PI_PASSWORD;
	try {
		return execSync("security find-generic-password -a pi-harness -s pi-harness-access -w", {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
}

const password = readPassword();
if (!password) {
	console.error("找不到密码：设置 PI_PASSWORD，或在钥匙串里存 pi-harness-access。");
	process.exit(2);
}

let cookie = "";
const results = [];

async function call(path, init = {}) {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
	});
	const text = await res.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		// 非 JSON（首页 HTML）
	}
	return { status: res.status, json, text, headers: res.headers };
}

async function check(name, fn) {
	try {
		const detail = await fn();
		results.push({ name, ok: true, detail });
	} catch (err) {
		results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
	}
}

function expect(condition, message) {
	if (!condition) throw new Error(message);
}

// ---- 登录 ----
{
	const res = await fetch(`${BASE}/api/login`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ password }),
	});
	const setCookie = res.headers.get("set-cookie") ?? "";
	const match = /pi_access=([^;]+)/.exec(setCookie);
	if (!res.ok || !match) {
		console.error(`登录失败：HTTP ${res.status}。检查密码是否正确。`);
		process.exit(1);
	}
	cookie = `pi_access=${match[1]}`;
}

// ---- 接口层 ----
await check("GET /", async () => {
	const res = await call("/");
	expect(res.status === 200, `HTTP ${res.status}`);
	expect(/<html/i.test(res.text), "不是 HTML");
	return "200";
});

await check("GET /api/version", async () => {
	const { json } = await call("/api/version");
	expect(typeof json?.build === "string" && json.build.length >= 7, "缺少 build");
	return json.build.slice(0, 7);
});

await check("GET /api/capabilities", async () => {
	const { json } = await call("/api/capabilities");
	const groups = (json?.groups ?? []).map((g) => g.key);
	expect(groups.join(",") === "builtin,data,protocol", `分组异常：${groups.join(",")}`);
	return `${json.groups.reduce((n, g) => n + g.items.length, 0)} 项`;
});

await check("GET /api/tools", async () => {
	const { json } = await call("/api/tools");
	const names = (json?.tools ?? []).map((t) => t.name);
	for (const required of ["codemode", "write_file", "read_file", "web_search", "update_plan", "dispatch_tasks", "ask_user", "set_goal", "install_skill", "kb_add", "kb_search"]) {
		expect(names.includes(required), `缺少工具 ${required}`);
	}
	return `${names.length} 个工具`;
});

await check("GET /api/kb/prefetch", async () => {
	const { json } = await call(`/api/kb/prefetch?q=${encodeURIComponent("测试")}`);
	expect(typeof json?.enabled === "boolean", "缺少 enabled");
	expect(typeof json?.block === "string", "缺少 block");
	return json.enabled ? "预检索开启" : "预检索关闭";
});

await check("GET /api/kernel", async () => {	const { json } = await call("/api/kernel");
	const packages = Object.keys(json?.current ?? {});
	for (const name of ["@earendil-works/pi-durable", "@earendil-works/pi-ai", "@earendil-works/pi-mcp", "@earendil-works/pi-codemode"]) {
		expect(packages.includes(name), `缺少 ${name}`);
	}
	return json.updateAvailable ? "有新版本可升" : "已是最新";
});

await check("GET /api/sessions", async () => {
	const { json } = await call("/api/sessions");
	expect(Array.isArray(json?.sessions), "sessions 不是数组");
	return `${json.sessions.length} 个会话`;
});

await check("GET /api/settings", async () => {
	const { json } = await call("/api/settings");
	expect(json?.compaction && typeof json.compaction.enabled === "boolean", "缺少 compaction");
	expect(json?.approval && typeof json.approval.write === "string", "缺少 approval");
	return `压缩 ${json.compaction.enabled ? "开" : "关"} / 写入 ${json.approval.write}`;
});

await check("GET /api/questions", async () => {
	const { json } = await call("/api/questions?sessionId=1");
	expect(Array.isArray(json?.questions), "questions 不是数组");
	return `${json.questions.length} 个待答`;
});

await check("GET /api/approvals", async () => {
	const { json } = await call("/api/approvals?sessionId=1");
	expect(Array.isArray(json?.approvals), "approvals 不是数组");
	return `${json.approvals.length} 个待批`;
});

await check("GET /api/custom-tools", async () => {
	const { json } = await call("/api/custom-tools");
	expect(Array.isArray(json?.tools), "tools 不是数组");
	return `${json.tools.length} 个自定义工具`;
});

// ---- 深度：真实对话验证工具执行链路 ----
let deepSessionId = null;
if (DEEP) {
	await check("POST /api/chat/stream（codemode 实跑）", async () => {
		const created = await call("/api/sessions", { method: "POST" });
		const sessionId = created.json?.id;
		deepSessionId = sessionId;
		expect(sessionId, "建会话失败");
		const res = await fetch(`${BASE}/api/chat/stream`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie },
			body: JSON.stringify({ sessionId, message: "用 codemode 算 12*34，只回数字。" }),
			signal: AbortSignal.timeout(180_000),
		});
		const text = await res.text();
		expect(/event: done/.test(text), "没有 done 事件");
		expect(/Script completed/.test(text), "codemode 没有正常执行（回归？）");
		expect(/408/.test(text), "结果不对（12*34 应为 408）");
		return "codemode 正常";
	});
	// 清掉冒烟用的会话，避免在侧栏堆积
	if (deepSessionId) await call(`/api/sessions?id=${deepSessionId}`, { method: "DELETE" }).catch(() => {});
}

// ---- 输出 ----
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
	console.log(`${r.ok ? "✓" : "✗"} ${r.name.padEnd(width)}  ${r.detail}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 失败` : ""}`);
process.exit(failed.length ? 1 : 0);
