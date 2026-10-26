import http from "node:http";

/** 假模型的一步：返回工具调用，或一段最终文本。 */
export type FakeStep =
	| { tool: { name: string; args: Record<string, unknown> } }
	| { text: string };

/**
 * 最小 OpenAI 兼容流式服务（测试用）：按步骤返回 tool_calls / content。
 * 只实现 pi-ai 用到的 SSE 子集，不访问外网。
 */
export function startFakeOpenAI(port: number) {
	let steps: FakeStep[] = [];
	let served = 0;
	/** 接下来若干次连接直接断开（NERE-85：模拟上游瞬时断流）。 */
	let drops = 0;
	let dropped = 0;
	const server = http.createServer((req, res) => {
		if (drops > 0) {
			drops--;
			dropped++;
			req.socket.destroy();
			return;
		}
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			served++;
			const step = steps.shift() ?? { text: "完成。" };
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const send = (delta: unknown, finish: string | null = null) =>
				res.write(
					`data: ${JSON.stringify({
						id: `chatcmpl-${served}`,
						object: "chat.completion.chunk",
						created: Math.floor(Date.now() / 1000),
						model: "fake",
						choices: [{ index: 0, delta, finish_reason: finish }],
					})}\n\n`,
				);
			send({ role: "assistant", content: null });
			if ("tool" in step) {
				send({
					tool_calls: [
						{
							index: 0,
							id: `call_${served}`,
							type: "function",
							function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) },
						},
					],
				});
				send({}, "tool_calls");
			} else {
				send({ content: step.text });
				send({}, "stop");
			}
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return {
		listen: () => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			server.once("error", reject);
			server.listen(port, "127.0.0.1", () => resolve());
			return promise;
		},
		close: () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			server.close(() => resolve());
			return promise;
		},
		/** 设置下一轮对话依次使用的步骤。 */
		setSteps: (next: FakeStep[]) => {
			steps = [...next];
			served = 0;
		},
		/** 接下来 count 次请求直接断连（不消耗步骤），用于验证重试。 */
		dropNext: (count: number) => {
			drops = count;
		},
		/** 已被断开的连接数（验证重试次数）。 */
		droppedCount: () => dropped,
	};
}
