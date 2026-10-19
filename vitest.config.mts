import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
		environment: "node",
		// 集成测试要启动 wrangler dev，给足超时
		testTimeout: 120_000,
		hookTimeout: 180_000,
		// 集成测试共用同一端口，串行跑
		fileParallelism: false,
	},
});
