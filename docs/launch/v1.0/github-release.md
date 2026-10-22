# v1.0.0 — A serverless Pi agent harness on Cloudflare

v1.0.0 is the first stable release of Cloudflare Free Web Pi: a multi-user AI workspace on your own Cloudflare account. One Worker, Durable Objects with SQLite. No VPS, Postgres, Redis, or object store.

At this cut (`65478ba`): 68 issues closed, 8/8 architecture stages merged, 12 installable prompt skills, and 559 tests in CI (558 passing, 1 skipped).

## Five things you get

1. **A durable agent, not a chat shell.** Work is persisted before it runs; restart the Durable Object and the turn resumes. Cron automations and goal mode keep going with the browser closed. v1.0 split the runtime into `routes/` → `services/` → `repo/`; `worker.ts` is the composition root only (#21, #23, #51, #54, #57).
2. **Per-user spaces.** Each invite code maps to its own Durable Object. Sessions, files, memory, knowledge base, and share tokens never cross. Revoking a user invalidates the login and every share link that user created, while their data is retained until an explicit, confirmed purge (#51, #59).
3. **Share links as the output.** A finished report is a file in the workbench, not a chat log. One click — or the `share_file` tool — produces a read-only page at `/s/<token>` on your own domain, with an expiry from one hour to forever, four themes, a TOC, and print / PDF. The share panel tracks opens and revokes links immediately (#11, #27, #29, #30, #42, #45).
4. **A knowledge base that answers first.** Per-user FTS5 with Chinese bigram tokenization and bm25; the top three chunks are injected before every turn, and the model can call `kb_search` itself. Import PDF, DOCX, Markdown, text, or a URL; identical sources dedupe, changed bodies replace in place (#10, #14, #31, #33, #38, #47).
5. **A Skill Hub with an audit gate.** The catalog ships 12 prompt skills (6 built in, 6 external). Prompt, JavaScript, and TypeScript skills pass; Python, shell, binaries, host APIs, and undeclared network calls are blocked before they reach the database, returning HTTP 422. `npm run catalog:check` is a CI gate (#40, #43, #46, #49, #53, #64).

## Deploy

The **Deploy to Cloudflare** button forks the repository, builds with Workers Builds (build command: `npm run build:web`), and deploys. Then add `DEEPSEEK_API_KEY` and `ACCESS_PASSWORD` as Worker secrets, and create the `pi-kb` Vectorize index once per account:

```bash
npx wrangler vectorize create pi-kb --dimensions=1024 --metric=cosine
```

The full command-line path and local setup are in the README.

## Demos

- **Read-only shared session** — verified HTTP 200 with `GET` at this commit: <https://pi-harness-gw.pages.dev/s/jrbxvkz8em3u>
- **Knowledge-base demo** — `TODO(demo-link)`: no public share token yet; deploy your own and share a session.
- **Skill Hub demo** — `TODO(demo-link)`: no public share token yet; run `npx wrangler dev` and open “Skills”.

## Upgrading

Old databases migrate automatically on first boot (schema v8); skills and history are untouched. After a deploy, an old Durable Object may run the previous build for 5–10 minutes; check `GET /api/version` before concluding a feature did not ship.

MIT. Not affiliated with Cloudflare, Inc.
