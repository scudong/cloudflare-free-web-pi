<div align="center">

<img src="docs/icon.svg" width="96" alt="Cloudflare Free Web Pi">

# Cloudflare Free Web Pi

### Your own AI workspace, on Cloudflare's free tier.

**Durable agent runtime · per-user spaces · Chinese knowledge base · files shared from your own domain.**<br>
One Worker and Durable Objects. No server, no external database.

[![Release](https://img.shields.io/github/v/release/scudong/cloudflare-free-web-pi?label=release&color=0ea5e9)](https://github.com/scudong/cloudflare-free-web-pi/releases) [![Stars](https://img.shields.io/github/stars/scudong/cloudflare-free-web-pi?style=flat&color=0ea5e9)](https://github.com/scudong/cloudflare-free-web-pi/stargazers) [![License](https://img.shields.io/badge/license-MIT-0ea5e9)](LICENSE) [![Deploy](https://github.com/scudong/cloudflare-free-web-pi/actions/workflows/deploy.yml/badge.svg)](https://github.com/scudong/cloudflare-free-web-pi/actions/workflows/deploy.yml)<br>
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white) ![Durable Objects](https://img.shields.io/badge/Durable%20Objects-SQLite-0ea5e9) ![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)

**English** · [简体中文](README.zh-CN.md) · [Quick start](#quick-start) · [Features](#what-you-get) · [How it works](#how-it-works) · [Deploy](#deploy)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/scudong/cloudflare-free-web-pi)

<img src="docs/screenshot.png" width="880" alt="Chat with tool calls, a Markdown file preview, and the knowledge base in the left rail">

<sub>Author's instance: **[pi-harness-gw.pages.dev](https://pi-harness-gw.pages.dev)** — invite code required; deploy your own for daily use.</sub>

</div>

## Why this exists

Most AI chat apps are rented, not owned:

- Close the tab and the context is gone.
- The report lives in a chat log, not a file you can send.
- Sharing means copy-paste, screenshots, or a link on someone else's domain.
- A team sharing one account has one shared history.
- Self-hosting usually means a VPS, Postgres, Redis, and a weekend.

Cloudflare Free Web Pi is the opposite: a workspace you deploy to your own Cloudflare account, with a durable agent, isolated spaces, a knowledge base, and files you share from your own domain.

## What you get

- **A durable agent, not a chat shell.** Work is persisted before it runs. Restart the Durable Object and it continues. Cron automations and goal mode keep going with the browser closed.
- **Per-user spaces.** Invite codes; each user gets their own Durable Object — sessions, files, memory, knowledge base, and share tokens are isolated. The owner issues, resets, and revokes codes from the UI.
- **Files with a share button — on your own domain.** The agent writes Markdown and HTML into a workbench. One click produces a public page served from your Cloudflare domain (the default `*.pages.dev` subdomain, or a custom domain you bind) with an expiry (1 hour to forever), four themes, and a table of contents.
- **A knowledge base that answers first.** Per-user FTS5 index with Chinese bigram tokenization and bm25. The top 3 chunks are injected before every turn; the model can also call `kb_search` itself. Switch to Vectorize + bge-m3, or hybrid retrieval (RRF), in Settings.
- **Real tools.** 24 built-in tools in the default install: web search, MCP servers, skills, prompts, rules, custom JS tools, parallel subagents, and a QuickJS codemode sandbox.
- **Control and visibility.** Read/write/exec tool approvals with per-tool overrides, thinking levels, a context meter, manual compaction, step plans, and structured `ask_user` cards.
- **Chinese-first, four themes.** The UI, prompts, and docs are written in Chinese; light, dark, sepia, and midnight themes; pages.dev proxy for access from mainland China.

## Quick start

About three minutes from clone to a working local instance (1–2 minutes installing dependencies, a few seconds to build the UI, 10–20 seconds for `wrangler dev` to come up).

```bash
git clone https://github.com/scudong/cloudflare-free-web-pi.git
cd cloudflare-free-web-pi
npm install

# Build the React app first: wrangler serves dist-web/ as static assets
npm run build:web

echo "DEEPSEEK_API_KEY=sk-..." >> .dev.vars
echo "ACCESS_PASSWORD=your-password" >> .dev.vars

npx wrangler dev     # Worker + Durable Objects: http://localhost:8787
```

Open `http://localhost:8787` and enter the password. Confirm the Worker is up:

```bash
curl http://localhost:8787/api/auth
# {"required":true,"authenticated":false,"owner":false}
```

For UI work, `npm run dev:web` runs Vite with hot reload on `http://localhost:5173` and proxies `/api` to 8787. `wrangler dev` serves the built `dist-web/`, so re-run `npm run build:web` after frontend changes.

**Local limits**: `wrangler dev` has no working `AI` or `Vectorize` binding, so vector and hybrid knowledge-base retrieval are empty locally. The default FTS5 keyword search works. Verify vector retrieval on a deployed instance.

Run the golden tests with `npm test` — unit, API, and multi-user isolation cases, including real `wrangler dev` instances (about 40 seconds). The deploy badge above is the source of truth for pass/fail; this README does not track a test count.

## How it works

<p align="center">
  <img src="docs/architecture.svg" width="920" alt="Browser → Cloudflare Worker → per-user Durable Object with pi-durable, SQLite, and tools">
</p>

- **One Worker** serves the React app and the API (`/api/*`, share pages at `/s/<token>`).
- **One Durable Object per user** holds sessions, files, memory, knowledge base, and share tokens in SQLite. No external database.
- **pi-durable** runs the agent loop and persists tasks; **QuickJS** runs codemode; **MCP** adds external tools; **DeepSeek** is the default model, and any OpenAI-compatible endpoint can be configured.

## Deploy

### One-click

The **Deploy to Cloudflare** button above (or [this link](https://deploy.workers.cloudflare.com/?url=https://github.com/scudong/cloudflare-free-web-pi)) copies the repository into your GitHub account, builds it with Workers Builds, and deploys it to your Cloudflare account.

- **Build command**: set it to `npm run build:web`. The repo has no `build` script, so leaving this blank deploys without `dist-web/` and fails.
- **Deploy command**: keep the default `npx wrangler deploy`.
- After the first deploy, add `DEEPSEEK_API_KEY` and `ACCESS_PASSWORD` under Worker → Settings → Variables and Secrets, then redeploy. **Without `ACCESS_PASSWORD` the site runs open to anyone.**
- Durable Objects, Workers AI, and the Vectorize index are provisioned from `wrangler.jsonc`.

### From the command line

```bash
npm install
npm run build:web
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put ACCESS_PASSWORD
npx wrangler deploy
```

Or push to `main` and let GitHub Actions deploy. Add `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `SMOKE_PASSWORD` to the repository secrets; CI runs the test suite, deploys, and smoke-tests the live Worker.

## Is it for you?

**Yes** if you want an AI workspace you own, reports you can share as links, or isolated spaces for a small team — without running a server.

**No** if you want a zero-setup SaaS, need vector/semantic search over millions of documents, or want a coding IDE rather than a general workspace.

## Docs

- [简体中文 README](README.zh-CN.md) — full feature table, architecture notes, HTTP API, and operational caveats
- [Knowledge base design](docs/knowledge-base.md) — why FTS5, how chunking and prefetch work, limits
- [Changelog](CHANGELOG.md) — every release, with test counts

## License

[MIT](LICENSE). Not affiliated with Cloudflare, Inc. Cloudflare, Workers, and Durable Objects are trademarks of Cloudflare, Inc.
