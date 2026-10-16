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
		// 相对路径以 vite root（src/web）为基准：../../dist-web = 项目根下的 dist-web
		outDir: "../../dist-web",
		emptyOutDir: true,
		sourcemap: false,
		chunkSizeWarningLimit: 800,
	},
});
