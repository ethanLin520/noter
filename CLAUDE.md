# Noter

Hosted, **multi-user** note-taking app for work meetings (real-time autocomplete + post-meeting
sanitize + Markdown/PDF export). Email+password login; each user's notes are isolated under
`notes/<userId>/`. Intended for a small team; accounts are created by an admin (no public signup).

## Progress tracking — READ AND UPDATE

- **At the start of a session, read `PROGRESS.md`** for the current state, decisions, file
  roles, open TODOs, and next steps. It is the source of truth for "where things are".
- **After each big edit or design/decision change, update `PROGRESS.md`** — keep the current
  state, decisions, open TODOs, and the `_Last updated:_` date in sync. Small/cosmetic edits
  don't need an update; new features, route/API changes, reversed decisions, and completed or
  newly-discovered TODOs do.

## Critical constraints

- **LLM backend is `claude -p` (Claude Code CLI, headless), not the Anthropic API.** It runs
  under the **single shared server login** — all users' AI calls go through it (`claude.ts`
  is user-agnostic; do not thread per-user identity into it).
- **Never use the `--bare` flag** — on this enterprise/managed account, auth comes through
  Claude Code settings (apiKeyHelper); `--bare` skips settings loading and breaks auth.
  Working invocation: `claude -p --model haiku --tools "" --output-format json`.
- All LLM calls go through `server/src/claude.ts` (the only module that spawns `claude`).
- **Auth + storage live in `server/src/auth.ts`**: users/sessions in a SQLite DB
  (`notes/.noter.db`, override via `NOTER_DB`), scrypt password hashing, opaque httpOnly
  session cookie, `requireAuth` gate. Accounts are created with `npm run add-user`.
- **Per-user isolation**: every filesystem path is built under the requesting user's root
  (`notes/<userId>/`) via `resolveInNotes(userRoot, …)` in `server/src/index.ts` — the
  path-traversal guard, now anchored per-user. Never reintroduce a global notes dir.

## Run / verify

```bash
npm run dev          # both servers (client :12345, server :23456); concurrently
npm run dev:server   # backend only
npm run dev:client   # frontend only
npm run install:all  # first-time deps (root + client; pulls Chromium for md-to-pdf)
npm run add-user -- <email> <password> "Display Name" [--admin]   # create an account
npm --prefix client run build   # client typecheck + build
npx tsc --noEmit                # server typecheck
npm run build && npm start      # production: serve built client + API on one port (:23456)
```

Stack: Vite + React + TS (client) · Node + Express + `tsx watch` (server) · Vite proxies
`/api` → `:23456` (in prod Express serves `client/dist` itself). Per-user notes persist under
`notes/<userId>/` (`.md` files, folder subdirs, `.trash/` bin); users/sessions in `notes/.noter.db`.
Export: Markdown is a client-side download; PDF is server-rendered via `md-to-pdf` +
`github-markdown-css` (`POST /api/export/pdf`). Deploy behind a TLS-terminating reverse proxy
(sets `secure` cookies; `trust proxy` is on).
