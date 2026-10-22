#!/usr/bin/env node
/**
 * 生成公开演示用的只读分享链接（NERE-13）。
 *
 * 只调用现有的 POST /api/share（kind=conversation / kind=file，ttlSeconds=0 表示永久），
 * 不做任何匿名写接口，也不改鉴权模型。生成后把输出的 /s/<token> 填到
 * wrangler.jsonc 的 DEMO_SHARE_URL，登录页就会出现「看一个真实对话」入口。
 *
 * 用法：
 *   node scripts/create-demo-share.mjs --session 722 --file 周报-2026-10-19.md
 *   PI_BASE=https://你的域名 PI_PASSWORD=... node scripts/create-demo-share.mjs ...
 *
 * 密码来源与 smoke 脚本一致：环境变量 PI_PASSWORD，或 macOS 钥匙串
 *   security find-generic-password -a pi-harness -s pi-harness-access -w
 *
 * 注意：ttlSeconds=0 会生成永久链接。运行前确认已经拿到公开演示的人工放行。
 */

import { execSync } from "node:child_process";

const BASE = (process.env.PI_BASE || "https://pi-harness-gw.pages.dev").replace(/\/+$/, "");
const args = process.argv.slice(2);

function arg(name, fallback = "") {
	const index = args.indexOf(`--${name}`);
	return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function allArgs(name) {
	const out = [];
	args.forEach((value, index) => {
		if (value === `--${name}` && args[index + 1]) out.push(args[index + 1]);
	});
	return out;
}

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

const sessionId = arg("session");
if (!sessionId) {
	console.error("缺少 --session <会话 id>（可在 /api/sessions 里查）");
	process.exit(2);
}
const theme = arg("theme", "light");
const files = allArgs("file");

const password = readPassword();
if (!password) {
	console.error("找不到密码：设置 PI_PASSWORD，或在钥匙串里存 pi-harness-access。");
	process.exit(2);
}

let cookie = "";

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
		// 非 JSON
	}
	return { status: res.status, json, text, headers: res.headers };
}

const login = await fetch(`${BASE}/api/login`, {
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ password }),
});
if (!login.ok) {
	console.error(`登录失败：HTTP ${login.status}`);
	process.exit(1);
}
const setCookie = login.headers.get("set-cookie") ?? "";
if (!/pi_access=/.test(setCookie)) {
	console.error("登录成功但没有拿到 pi_access cookie");
	process.exit(1);
}
cookie = setCookie.split(";")[0];
console.log(`已登录 ${BASE}`);

async function createShare(kind, name) {
	const res = await call("/api/share", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ sessionId, kind, ...(name ? { name } : {}), ttlSeconds: 0, theme }),
	});
	if (res.status !== 200 || !res.json?.url) {
		throw new Error(`${kind}${name ? ` ${name}` : ""} 生成失败：${res.status} ${res.json?.error ?? res.text.slice(0, 120)}`);
	}
	return res.json;
}

const conversation = await createShare("conversation");
console.log(`对话分享：${conversation.url}`);

const fileShares = [];
for (const name of files) {
	const share = await createShare("file", name);
	fileShares.push({ name, url: share.url });
	console.log(`文件分享：${share.url}（${name}）`);
}

const demoPath = new URL(conversation.url).pathname;
console.log("");
console.log("把下面这行写进 wrangler.jsonc 的 vars（或部署时用 --var 传入）：");
console.log(`  "DEMO_SHARE_URL": "${demoPath}"`);
console.log("");
console.log("提示：分享页是 noindex、只读快照；链接永久有效（ttlSeconds=0）。");
console.log(
	JSON.stringify(
		{ conversationUrl: conversation.url, demoShareUrl: demoPath, fileUrls: fileShares, expiresAt: conversation.expiresAt },
		null,
		2,
	),
);
