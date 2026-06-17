# Noter

Local, personal, single-user note-taking app for work meetings (real-time autocomplete +
post-meeting sanitize). Local-only — no auth, no deploy, no multi-user.

## Progress tracking — READ AND UPDATE

- **At the start of a session, read `PROGRESS.md`** for the current state, decisions, file
  roles, open TODOs, and next steps. It is the source of truth for "where things are".
- **After each big edit or design/decision change, update `PROGRESS.md`** — keep the current
  state, decisions, open TODOs, and the `_Last updated:_` date in sync. Small/cosmetic edits
  don't need an update; new features, route/API changes, reversed decisions, and completed or
  newly-discovered TODOs do.

## Critical constraints

- **LLM backend is `claude -p` (Claude Code CLI, headless), not the Anthropic API.**
- **Never use the `--bare` flag** — on this enterprise/managed account, auth comes through
  Claude Code settings (apiKeyHelper); `--bare` skips settings loading and breaks auth.
  Working invocation: `claude -p --model haiku --tools "" --output-format json`.
- All LLM calls go through `server/src/claude.ts` (the only module that spawns `claude`).
- All filesystem paths built from user input must go through `resolveInNotes()` in
  `server/src/index.ts` (path-traversal guard).

## Run / verify

```bash
npm run dev          # both servers (client :12345, server :23456); concurrently
npm run dev:server   # backend only
npm run dev:client   # frontend only
npm run install:all  # first-time deps (root + client)
npm --prefix client run build   # client typecheck + build
npx tsc --noEmit                # server typecheck
```

Stack: Vite + React + TS (client) · Node + Express + `tsx watch` (server) · Vite proxies
`/api` → `:23456`. Notes persist under `notes/` (`.md` files, folder subdirs, `.trash/` bin).
