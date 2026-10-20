#!/usr/bin/env node
/**
 * pi 内核升级（v0.35.0）
 *
 * 查 npm 上 pi-* 四个包的最新版本 → 安装 → 构建 → 跑金标 → 打包校验，
 * 任何一步失败都回滚 package.json / package-lock.json，避免半升级状态进仓库。
 *
 * 用法：
 *   npm run upgrade:pi            # 升级 + 全量校验
 *   npm run upgrade:pi -- --dry-run  # 只打印将要升级的版本
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** 与 worker.ts 里的 PI_PACKAGES 保持一致。 */
const PACKAGES = [
	"@earendil-works/pi-durable",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-mcp",
	"@earendil-works/pi-codemode",
];

const dryRun = process.argv.includes("--dry-run");

function run(command) {
	execSync(command, { stdio: "inherit", env: process.env });
}

function runQuiet(command) {
	execSync(command, { stdio: "ignore", env: process.env });
}

async function latestVersion(name) {
	const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, {
		headers: { accept: "application/json" },
	});
	if (!res.ok) throw new Error(`${name}: npm registry HTTP ${res.status}`);
	const data = await res.json();
	if (typeof data.version !== "string") throw new Error(`${name}: 响应里没有 version`);
	return data.version;
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const declared = pkg.dependencies ?? {};

const targets = [];
for (const name of PACKAGES) {
	const current = String(declared[name] ?? "").replace(/^[^\d]*/, "");
	const next = await latestVersion(name);
	if (!current) {
		targets.push(`${name}@${next}`);
		continue;
	}
	if (current !== next) targets.push(`${name}@${next}`);
}

if (targets.length === 0) {
	console.log("pi 内核已是最新版本。");
	process.exit(0);
}

console.log("将升级：", targets.join(" "));
if (dryRun) process.exit(0);

const backup = {
	pkg: readFileSync("package.json", "utf8"),
	lock: readFileSync("package-lock.json", "utf8"),
};

try {
	run(`npm install ${targets.join(" ")}`);
	run("npm run build:web");
	run("npm test");
	// 打包校验：Workers 运行时没有 Node API，这一步能抓住平台不兼容的升级
	run("npx wrangler deploy --dry-run --outdir .wrangler/upgrade-check");
	console.log("\n✅ pi 内核升级完成，构建 / 金标 / 打包校验全部通过。");
} catch (error) {
	console.error("\n❌ 升级失败，回滚 package.json 与 package-lock.json。", error?.message ?? "");
	writeFileSync("package.json", backup.pkg);
	writeFileSync("package-lock.json", backup.lock);
	try {
		runQuiet("npm install --ignore-scripts");
	} catch {
		console.error("回滚后重新安装失败，请手动执行 npm ci。");
	}
	process.exit(1);
}
