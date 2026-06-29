# Noter

A hosted, **multi-user** note-taking app for work meetings. Type fast shorthand and get
real-time autocomplete corrections; afterwards, run "sanitize" to polish the note into clean
Markdown, or roll a whole folder up into a digest. Export to Markdown or PDF. Email+password
login; each user's notes are isolated on disk. Built for a small team — accounts are created by
an admin (no public signup).

## Features

- **Autocomplete** — pause typing to get a suggestion that fixes typos and shorthand without
  inventing content. `Tab` accepts, `Esc` dismisses, `⌘Z` undoes a just-accepted suggestion.
- **Sanitize** — polish the whole note into readable Markdown without changing its meaning;
  asks clarifying questions instead of guessing.
- **Folder summarize** — roll a folder's notes into one digest; steer and regenerate it.
- **Export** — download a note as Markdown (client-side) or as a server-rendered PDF.
- **Rendered + edit modes**, **search**, **autosave**, **recycle bin**, **drag-and-drop** filing,
  inline rename/create, and a resizable sidebar.

## Accounts & isolation

Login is email+password (scrypt-hashed). Sessions are opaque, server-side tokens in an httpOnly
cookie. Each user's notes live isolated under `notes/<userId>/` (their own `.md` files, folder
subdirs, and recycle bin); users and sessions are stored in SQLite (`notes/.noter.db`). There's
no signup UI — an admin creates accounts from the CLI:

```bash
npm run add-user -- <email> <password> "Display Name" [--admin]
```

## Stack

Vite + React + TypeScript (client, `:12345`) · Node + Express (server, `:23456`). The LLM backend
is the `claude -p` CLI (Claude Code, headless) running under a single shared server login — uses
that login, no API key. PDF export renders Markdown server-side via `md-to-pdf` +
`github-markdown-css`.

## Getting started

Requires [Claude Code](https://claude.com/claude-code) installed and logged in.

```bash
npm run install:all   # first-time deps (root + client; pulls Chromium for md-to-pdf)
npm run add-user -- you@example.com 'password' "Your Name"   # create an account

make run-bg   # start both servers in the background; open http://localhost:12345
make logs     # tail the logs
make kill     # stop both servers
make run      # run in the foreground instead (Ctrl-C to stop)
```

Or use the npm scripts directly: `npm run dev` (both servers), `npm run dev:server`,
`npm run dev:client`.

## Production

Build the client and serve it plus the API from a single Express process, behind a
TLS-terminating reverse proxy (so `secure` cookies work; `trust proxy` is on):

```bash
npm run build && npm start   # serves built client + API on :23456
```
