<div align="center">

<img src="docs/icon.svg" width="96" alt="Cloudflare Free Web Pi">

# Cloudflare Free Web Pi

### Your own AI workspace, on Cloudflare's free tier.

**Durable agent runtime · per-user spaces · Chinese knowledge base · shareable files.**<br>
One Worker and Durable Objects. No server, no external database.

[![Release](https://img.shields.io/github/v/release/scudong/cloudflare-free-web-pi?label=release&color=0ea5e9)](https://github.com/scudong/cloudflare-free-web-pi/releases) [![Stars](https://img.shields.io/github/stars/scudong/cloudflare-free-web-pi?style=flat&color=0ea5e9)](https://github.com/scudong/cloudflare-free-web-pi/stargazers) [![License](https://img.shields.io/badge/license-MIT-0ea5e9)](LICENSE) [![Tests](https://img.shields.io/badge/tests-126-22c55e)](tests)<br>
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white) ![Durable Objects](https://img.shields.io/badge/Durable%20Objects-SQLite-0ea5e9) ![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)

**English** · [简体中文](README.zh-CN.md) · [Quick start](#quick-start) · [Features](#what-you-get) · [How it works](#how-it-works) · [Deploy](#deploy)

<img src="docs/screenshot.png" width="880" alt="Chat with tool calls, a Markdown file preview, and the knowledge base in the left rail">

</div>

## Why this exists

Most AI chat apps are rented, not owned:

- Close the tab and the context is gone.
- The report lives in a chat log, not a file you can send.
- Sharing means copy-paste, screenshots, or a vendor link.
- A team sharing one account has one shared history.
- Self-hosting usually means a VPS, Postgres, Redis, and a weekend.

Cloudflare Free Web Pi is the opposite: a workspace you deploy to your own Cloudflare account, with a durable agent, isolated spaces, a knowledge base, and files you can share.

## What you get

- **A durable agent, not a chat shell.** Work is persisted before it runs. Restart the Durable Object and it continues. Cron automations and goal mode keep going with the browser closed.
- **Per-user spaces.** Invite codes; each user gets their own Durable Object — sessions, files, memory, knowledge base, and share tokens are isolated. The owner issues, resets, and revokes codes from the UI.
- **Files with a share button.** The agent writes Markdown and HTML into a workbench. One click produces a public page with an expiry (1 hour to forever), four themes, and a table of contents.
- **A knowledge base that answers first.** Per-user FTS5 index with Chinese bigram tokenization and bm25. The top 3 chunks are injected before every turn; the model can also call `kb_search` itself.
- **Real tools.** 27 built-in tools in the default install: web search, MCP servers, skills, prompts, rules, custom JS tools, parallel subagents, and a QuickJS codemode sandbox.
- **Control and visibility.** Read/write/exec tool approvals with per-tool overrides, thinking levels, a context meter, manual compaction, step plans, and structured `ask_user` cards.
- **Chinese-first, four themes.** The UI, prompts, and docs are written in Chinese; light, dark, sepia, and midnight themes; pages.dev proxy for access from mainland China.

## Quick start

```bash
git clone https://github.com/scudong/cloudflare-free-web-pi.git
cd cloudflare-free-web-pi
npm install

echo "DEEPSEEK_API_KEY=sk-..." >> .dev.vars
echo "ACCESS_PASSWORD=your-password" >> .dev.vars

npm run dev:web      # UI: http://localhost:5173
npx wrangler dev     # Worker + Durable Objects: http://localhost:8787
```

Open `http://localhost:5173`, enter the password, and start a conversation. The full Chinese setup guide, feature table, and HTTP API reference are in [README.zh-CN.md](README.zh-CN.md).

Run the golden tests with `npm test` — 126 unit, API, and multi-user isolation tests, including real `wrangler dev` instances.

## How it works

<p align="center">
  <img src="docs/architecture.svg" width="920" alt="Browser → Cloudflare Worker → per-user Durable Object with pi-durable, SQLite, and tools">
</p>

- **One Worker** serves the React app and the API (`/api/*`, share pages at `/s/<token>`).
- **One Durable Object per user** holds sessions, files, memory, knowledge base, and share tokens in SQLite. No external database.
- **pi-durable** runs the agent loop and persists tasks; **QuickJS** runs codemode; **MCP** adds external tools; **DeepSeek** is the default model, and any OpenAI-compatible endpoint can be configured.

## Deploy

```bash
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put ACCESS_PASSWORD
npx wrangler deploy
```

Or push to `main` and let GitHub Actions deploy. Add `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `SMOKE_PASSWORD` to the repository secrets; CI runs the 126 tests, deploys, and smoke-tests the live Worker.

## Is it for you?

**Yes** if you want an AI workspace you own, reports you can share as links, or isolated spaces for a small team — without running a server.

**No** if you want a zero-setup SaaS, need vector/semantic search over millions of documents, or want a coding IDE rather than a general workspace.

## Docs

- [简体中文 README](README.zh-CN.md) — full feature table, architecture notes, HTTP API, and operational caveats
- [Knowledge base design](docs/knowledge-base.md) — why FTS5, how chunking and prefetch work, limits
- [Changelog](CHANGELOG.md) — every release, with test counts

## License

[MIT](LICENSE). Not affiliated with Cloudflare, Inc. Cloudflare, Workers, and Durable Objects are trademarks of Cloudflare, Inc.
