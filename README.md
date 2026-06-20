# Noter

A local, single-user note-taking app for work meetings. Type fast shorthand and get
real-time autocomplete corrections; afterwards, run "sanitize" to polish the note into
clean Markdown. Notes are plain `.md` files on disk — no accounts, no cloud.

## Features

- **Autocomplete** — pause typing to get a suggestion that fixes typos and shorthand without
  inventing content. `Tab` accepts, `Esc` dismisses, `⌘Z` undoes.
- **Sanitize** — polish the whole note into readable Markdown without changing its meaning.
- **Folder summarize** — roll a folder's notes into one digest.
- **Markdown view, search, autosave, recycle bin, drag-and-drop** filing.

## Stack

Vite + React + TypeScript (client, `:12345`) · Node + Express (server, `:23456`). The LLM
backend is the `claude -p` CLI (Claude Code, headless) — uses your existing login, no API key.

## Getting started

Requires [Claude Code](https://claude.com/claude-code) installed and logged in.

```bash
npm run install:all   # first-time deps

make run-bg   # start both servers in the background; open http://localhost:12345
make logs     # tail the logs
make kill     # stop both servers
make run      # run in the foreground instead (Ctrl-C to stop)
```
