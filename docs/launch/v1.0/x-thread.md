# X thread — v1.0.0 (English, 6 posts)

**Channel:** X. **Publish window:** 21:00–23:00 Beijing time (covers US morning plus the
domestic evening, per `marketing/05-traffic-playbook.md`). **Frequency:** one thread, then reply
to 5 relevant Cloudflare / self-hosted-AI posts the same day.

Every post below is ≤280 characters as raw text; X counts each URL as 23 characters, so the
effective length is shorter. Copy the text as-is; do not add “revolutionary”, “game-changing”,
or any star/user/benchmark number.

---

**1/6 — result + link** (274 characters)

```text
v1.0.0 of Cloudflare Free Web Pi is out: a multi-user AI workspace on Cloudflare's free tier. One Worker, Durable Objects + SQLite, no server.

68 issues closed. 8/8 architecture stages merged. 559 tests in CI.

Read-only demo: https://pi-harness-gw.pages.dev/s/jrbxvkz8em3u
```

Attach: `docs/screenshot.png`.

**2/6 — Durable Object SQLite** (269 characters)

```text
The database is the Durable Object.

Sessions, files, memory, knowledge base, approvals and share tokens live in per-user DO SQLite, through versioned migrations (v8).

Tasks are persisted before they run, so a restarted object resumes the turn.

No Postgres. No Redis.
```

Attach: `docs/architecture.png`.

**3/6 — Skill Hub audit gate** (267 characters)

```text
Skills install only after an audit.

Prompt / JS / TS pass. Python, shell, binaries, host APIs and undeclared network calls are blocked before they touch the database — HTTP 422, nothing written.

12 prompt skills in the catalog.
`npm run catalog:check` is a CI gate.
```

Attach: `docs/assets/v1/skill-hub.png`.

**4/6 — share as output** (255 characters)

```text
The share link is the output.

A finished report is a file in the workbench, not a chat log. One click — or the `share_file` tool — gives a read-only page at /s/<token> on your own domain: expiry, four themes, TOC, print/PDF.

Revoke it and the link 404s.
```

Attach: `docs/assets/v1/share-page.png`.

**5/6 — 8-stage layering** (241 characters)

```text
8/8 architecture stages merged.

Versioned migrations. routes → services → repo. Zero SQL in routes. Share pages that never open the agent. worker.ts as composition root only.

CI fails if DDL or the old sqlFacade leaks back into the worker.
```

Attach: none (text-only post reads better here).

**6/6 — deploy entry** (266 characters)

```text
Deploy your own in about 5 minutes:

• Deploy to Cloudflare button
• build: `npm run build:web`
• add DEEPSEEK_API_KEY + ACCESS_PASSWORD
• create the pi-kb Vectorize index once

MIT. Repo: https://github.com/scudong/cloudflare-free-web-pi

#Cloudflare #buildinpublic
```

Attach: `docs/social-preview.png`.

---

## Posting notes

- **Link placement trade-off.** This issue asks for the link in post 1; the playbook
  (`05-traffic-playbook.md`) recommends putting links last for reach. If you take the link-last
  route, delete the demo line from post 1 (it becomes 210 raw characters) and put the demo URL
  in a reply to your own thread — post 6 is already 266 characters and has no room for a second
  link.
- **Hashtags:** only post 6 carries the two allowed tags (`#Cloudflare`, `#buildinpublic`).
  Adding tags to every post reads as spam and dilutes the hook.
- **Reply own thread** after publishing with one concrete number not already in the thread, e.g.
  “17 first-screen panels now load from one `/api/bootstrap` request instead of 18 (#17, #20).”
  Do not add a second CTA.
- **What not to write:** no “fully free” (say “Cloudflare free tier, model billed per use”), no
  “online demo” (the only public artifact is one read-only shared session), no user or star
  numbers.

## Fact sources

- `CHANGELOG.md` § v1.0.0 (`main@65478ba`): issues closed, 8/8 stages, 12 skills, PR numbers.
- CI run for `65478ba`, job `test`: 48 files, 558 passed, 1 skipped (559).
- Read-only demo verified with `GET https://pi-harness-gw.pages.dev/s/jrbxvkz8em3u` → HTTP 200.
