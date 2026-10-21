import { existsSync, rmSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

/**
 * 停掉 detached 启动的 `wrangler dev` 进程组，再删测试 persist 目录。
 *
 * 为什么不能直接 `kill` 完就 `rmSync`：process.kill 是异步的，workerd 还在往
 * persist 目录落盘，此时 rmSync 会抛 `ENOTEMPTY: Directory not empty`。
 * vitest 会把这条 afterAll 异常记成「整个测试文件失败」——即使里面所有用例都过了，
 * `npm test` 仍然非 0 退出。表现为「本地跑不出一份全绿」，跟产品代码无关。
 *
 * 所以：先等子进程退出（最多 5s），再删；删不掉就重试，最多 5s。
 */
export async function stopServer(proc: ChildProcess | null, stateDir: string): Promise<void> {
	if (proc?.pid) {
		const pid = proc.pid;
		const exited = new Promise<void>((resolve) => {
			proc.once("exit", () => resolve());
			setTimeout(resolve, 5_000);
		});
		try {
			// detached: true 时子进程自成一组，负 pid 杀整组（npx → node → workerd）
			process.kill(-pid, "SIGTERM");
		} catch {
			proc.kill("SIGTERM");
		}
		await exited;
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// 已经退出了
		}
	}

	for (let i = 0; i < 50; i++) {
		try {
			rmSync(stateDir, { recursive: true, force: true });
			if (!existsSync(stateDir)) return;
		} catch {
			// workerd 还在收尾写盘，稍等重试
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	console.warn(`[test] 未能清理测试状态目录：${stateDir}`);
}
