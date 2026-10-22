# Repository metadata — v1.0.0

Suggestions only. This PR does not change any repository setting; apply these by hand in
**Settings → General** (About, Topics) and **Settings → Social preview**.

## About (one line, ≤120 characters)

```text
Your own multi-user AI workspace on Cloudflare's free tier: durable agent, per-user spaces, shareable files.
```

- Length: 108 characters (including spaces).
- Why this wording: it names the category (multi-user AI workspace), the constraint (Cloudflare free tier), and three concrete nouns people search for. It avoids “revolutionary”, “next-gen”, and claims this repo cannot back with a file.
- Alternative if 120 is too tight on mobile: `A durable, multi-user AI workspace on Cloudflare's free tier. One Worker, SQLite, no server.` (92 characters).

## Topics (10, ordered by search value)

| # | Topic | Why |
|---|---|---|
| 1 | `cloudflare-workers` | The exact platform people browse; the repo is one Worker. |
| 2 | `ai-agent` | The category term with the largest audience. |
| 3 | `durable-objects` | The distinctive implementation detail; low competition, high intent. |
| 4 | `self-hosted` | The “own it instead of rent it” audience from the launch copy. |
| 5 | `llm` | Broad discovery term; still accurate (DeepSeek by default, any OpenAI-compatible endpoint). |
| 6 | `cloudflare` | Parent platform; catches viewers who do not know Workers. |
| 7 | `typescript` | Language filter; most of the codebase. |
| 8 | `sqlite` | Explains the “no Postgres” claim in one word. |
| 9 | `knowledge-base` | Feature-level search intent (FTS5, Chinese retrieval). |
| 10 | `ai-workspace` | Position, not a feature; keeps the About line and topics consistent. |

Deliberately excluded: `chatbot` and `chatgpt` (wrong category and wrong expectation), `rag`
(vector search is optional, not the default), `react` (framework detail, no discovery value here),
`deepseek` (a provider choice, not the product).

## Social preview (1280 × 640)

GitHub shows this card when the repo link is pasted into X, Slack, Reddit, or iMessage. The
existing renderer is `marketing/social-preview.html`; it needs re-export at 1280 × 640 before
upload (the current CSS canvas is 1200 × 630).

**Headline (2 lines, largest text)**

```text
Your own AI workspace,
on Cloudflare's free tier.
```

**Subline**

```text
Durable agent · per-user spaces · Chinese-first knowledge base · shareable files. One Worker. No server.
```

**Chips (bottom row, four maximum)**

```text
12 prompt skills   Durable Objects + SQLite   Invite-code spaces   Share links with expiry
```

**Alt text**

```text
Cloudflare Free Web Pi: a chat with tool calls, a Markdown report preview, and a knowledge-base panel, on a dark background.
```

**Open Graph / Twitter card fallbacks**

- `og:title` (≤60 characters): `Cloudflare Free Web Pi — your own AI workspace` (46)
- `og:description` (≤200 characters): `A durable, multi-user AI workspace on Cloudflare's free tier. One Worker, Durable Objects + SQLite, per-user spaces, a Chinese-first knowledge base, and share links on your own domain.` (184)

**Do not put in the card:** star counts, user counts, benchmark numbers, or the word “online
demo”. The only public artifact at v1.0.0 is one read-only shared session
(`/s/jrbxvkz8em3u`), and the production instance otherwise requires an invite code.

## Sources

- Feature claims and counts: `CHANGELOG.md` § v1.0.0 (`main@65478ba`), `skills/catalog.json`.
- Test count: CI run for `65478ba` — 48 test files, 558 passed, 1 skipped (559).
- Existing social card: `marketing/social-preview.html`, `docs/social-preview.png`.
