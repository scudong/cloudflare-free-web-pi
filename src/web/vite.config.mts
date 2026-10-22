import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 独立 Vite 项目：root = src/web。
// `npm run build:web`（根目录）= vite build src/web --outDir ../dist-web
// 开发时 /api 代理到 wrangler dev（默认 8787），同域相对路径与线上一致。
export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		proxy: {
			"/api": { target: "http://127.0.0.1:8787", changeOrigin: false },
		},
	},
	build: {
		// 首包 gzip 预算 150 KB（NERE-81）。entry 目前 ≈112 KB；设置 / 知识库+MCP / 技能
		// 三个弹窗走动态 import 分包（见 App.tsx）。超预算先看 `vite build` 的 gzip 行。
		// 相对路径以 vite root（src/web）为基准：../../dist-web = 项目根下的 dist-web
		outDir: "../../dist-web",
		emptyOutDir: true,
		sourcemap: false,
		chunkSizeWarningLimit: 800,
	},
});
