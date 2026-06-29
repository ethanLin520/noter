# Noter — Progress

Hosted, **multi-user** note-taking app for work meetings. Type fast/shorthand notes, get
real-time autocomplete corrections and a post-meeting "sanitize" polish, and export to
Markdown/PDF. Email+password login; each user's notes are isolated under `notes/<userId>/`.
Small team, admin-created accounts (no public signup). LLM still via `claude -p` under one
shared server login.

_Last updated: 2026-06-28 — **autocomplete model switch**: autocomplete now runs on **sonnet** with **`--effort low`** (new `effort` option on `runClaude` → `claude -p --effort <level>`), keeping thinking disabled (`MAX_THINKING_TOKENS=0`). Prior same-day: **security hardening pass** (post code-review): PDF export now runs
Chromium with `--host-resolver-rules=MAP * 0.0.0.0` (blocks SSRF from attacker-controlled note
markdown) + a 2-render concurrency cap; login always runs scrypt (dummy credential for unknown
emails, kills the user-enumeration timing channel) and is rate-limited (10/IP/15min); session
cookie `secure` now derives from `req.secure` (X-Forwarded-Proto) instead of `NODE_ENV`; prod CORS
defaults to no cross-origin (was reflect-any `true`); `ensureUserDir` memoized (was a blocking
`mkdirSync` every request); `userRootFor` moved to `auth.ts` as the single per-user-root source.
Earlier 2026-06-28 — **went multi-user/hosted**: added email+password auth (scrypt +
opaque httpOnly session cookie, users/sessions in SQLite `notes/.noter.db`), per-user note
isolation under `notes/<userId>/` (`resolveInNotes` now takes a user root; all handlers + trash
threaded), a `requireAuth` gate on every data/AI route, an admin `add-user` CLI, a login screen
+ logout, and note **export** (Markdown via client Blob download; PDF server-rendered with
`md-to-pdf` + `github-markdown-css`). `claude.ts` unchanged (shared login). Prod: Express serves
the built client; CORS tightened + `trust proxy`. Verified end-to-end via curl (gating, login,
isolation, CRUD, real `%PDF`). Prior: 2026-06-22 — sorting now uses **last edit (mtime)** for both notes and folders (sort modes renamed `created-*` → `edited-*`; folders ordered by their latest-edited note, alphabetical only in `name` mode); gave the confirm-dialog backdrop a `z-index` so it sits above the editor/popovers. Prior: 2026-06-20 (v1.1.2) — added an app logo (favicon + sidebar), a last-edited timestamp in the toolbar header, and Esc-to-preview in edit mode. Also cut autocomplete latency ~2-4x by disabling thinking (`MAX_THINKING_TOKENS=0`) on the haiku call. Details in **Current state** below._

---

## Current state

Working and verified end-to-end:

- **Multi-user auth** — email+password login gates the app. Passwords hashed with built-in
  `crypto.scrypt`; sessions are opaque `randomBytes` tokens in an httpOnly, SameSite=Lax cookie
  (`secure` set from `req.secure`/X-Forwarded-Proto, so it's on behind the TLS proxy), stored server-side in SQLite (`notes/.noter.db`, override via `NOTER_DB`).
  `auth.ts` owns the DB, hashing, sessions, and the `requireAuth` middleware; `index.ts` mounts
  `POST /api/login`, `POST /api/logout`, `GET /api/me`, a public `GET /api/ping`, then
  `app.use("/api", requireAuth)` so every data/AI route below requires a session. Accounts are
  created by an admin via `npm run add-user -- <email> <pw> "Name" [--admin]` (no signup UI).
  Client gates on mount via `GET /api/me` (loading→login→app); a 401 from any call bounces to
  login (App stays mounted so unsaved edits survive a re-login). Logout + current user sit in the
  sidebar footer. curl-verified: ping public, data routes 401 without a cookie, login sets the
  cookie, wrong password 401, logout invalidates.
- **Per-user storage** — each user's notes live under `notes/<userId>/` (own unfiled notes,
  folder subdirs, and `.trash/` + `trash.json`). `resolveInNotes(userRoot, …)` re-anchors the
  traversal guard per-user; every fs handler derives `userRoot = notes/<req.user.id>` first.
  `userId` is a random `base64url` id (not the email). Verified: two users see only their own
  notes on disk and via `/api/tree`.
- **Export** — toolbar **.md** downloads the raw markdown client-side (Blob, no server). **PDF**
  POSTs the current markdown to `POST /api/export/pdf`, rendered server-side by `md-to-pdf`
  styled with `github-markdown-css` (light theme, `.markdown-body`), returned as a `Buffer`
  (wrap the Uint8Array or Express JSON-serializes it). Both disabled on an empty note; PDF shows
  a busy state. Verified: returns a real `%PDF-1.4` document.
- **Real-time autocomplete** — ghost-text-on-pause (~900ms debounce). The suggestion shows in
  a **floating card anchored just below the line the caret is on** (flips above the line near
  the editor's bottom edge, follows textarea scroll), so it appears where you're typing rather
  than pinned to the bottom of the pane. Tab accepts, Esc dismisses. Caret pixel position is
  measured via a hidden mirror-div (`caretCoords` in `Editor.tsx`); the card is absolutely
  positioned inside the `position: relative` `.editor` box (`.suggestion-pop`). Minimal
  corrections only (typos, abbreviations) — never invents content. **Undo an accept**: right
  after accepting a suggestion, `⌘Z`/`Ctrl+Z` reverts just that replacement (React value
  changes don't enter the textarea's native undo stack, so `Editor.tsx` snapshots the
  pre-accept state in `lastAcceptRef` and restores it; any manual keystroke clears the
  snapshot so native undo resumes). **Model + speed tuning**: the autocomplete `claude -p`
  call runs on **sonnet** with **`--effort low`** (`runClaude`'s `effort` option) and thinking
  disabled via `MAX_THINKING_TOKENS=0` (`runClaude`'s `disableThinking` option, set in the
  child env). The thinking-off tuning originated on haiku, which was emitting ~130 hidden
  thinking tokens for a ~5-token answer; disabling it cut per-call API time from ~1.5-4s to
  ~0.9s with identical output. Sanitize/summarize keep thinking on.
- **Rendered (read) mode** — formatted-Markdown view (`react-markdown` + `remark-gfm`) shown
  alongside the raw textarea. A toolbar **Preview/Edit** toggle switches between them. Notes open
  in rendered mode and auto-switch to rendered after a sanitize; new blank notes start in edit
  mode. Clicking the rendered view drops into edit mode with the caret at the clicked spot (a
  `rehypeSourceOffset` plugin stamps `data-pos` offsets; the click maps back via `caretFromPoint`
  + a block-anchored text search). In edit mode, **Esc returns to rendered/preview** (a first
  Esc dismisses an active autocomplete suggestion before exiting to preview).
- **Post-meeting sanitize** — stronger model polishes the whole note into Markdown without
  changing meaning; asks clarifying questions via a `QUESTIONS:` block (multi-turn resume loop)
  rather than guessing.
- **Folder summarize** — ✨ on a folder row rolls every note in that folder up into one weekly
  digest (Opus). `SummaryPanel` previews the result; "Save to folder" writes a canonical
  `<folder> Summary.md` inside that folder (overwritten on re-run) and opens it. The summarizer
  skips the folder's own summary note so it never feeds its own output back in. Grounded-only
  prompt (`SUMMARIZE_SYSTEM`) — sections for overview / decisions / action items / open questions
  / themes; never invents. **Steerable regenerate**: a text box in the preview lets you give an
  instruction (e.g. "focus on decisions", "make it shorter"); it resumes the summary session via
  `POST /api/folder/summarize/reply` to revise the existing digest. An empty box re-summarizes
  from scratch (new session).
- **New notes are unfiled** — new **top-level** notes (⌘N and the top "+ Note") are created as
  unfiled (folder `""`); the user files them manually via drag-and-drop or move. Explicit
  "+ Note in folder" still creates inside the chosen folder. (Removed the prior weekly
  auto-foldering / `client/src/week.ts`.)
- **VSCode-style inline create** — "+ Note" shows a naming input as a row in the Unfiled list;
  "+ Folder" shows one as a new folder row at the top of the Folders area; "+ Note in folder"
  shows one inside that folder. All use `InlineInput` (Enter saves, Esc/blur cancels); an empty
  folder name just cancels. The inputs render in their tree position, not under the buttons.
- **Note & folder management** — create / rename / move / delete notes; create / rename / delete
  single-level folders (rename errors on name collision, no merge); recycle bin with restore /
  permanent-delete / empty-bin (manual, nothing auto-purges). **Rename is inline** (the sidebar
  name becomes an editable `InlineInput`, prefilled + selected; Enter saves, Esc/blur cancels).
  **Delete is a confirm modal** (`ConfirmDialog` in `client/src/Dialog.tsx`) with a red Delete
  button; same dialog backs the recycle bin's Delete-forever / Empty-bin. No more native
  `window.prompt` / `window.confirm`.
- **Sorting** — both notes and folders sort by **last edit (mtime), most recent first** by
  default. A small button in the sidebar actions cycles the order: Last edited (`↓`) → Least
  recently edited (`↑`) → Name A–Z (`A`). Server-side
  (`GET /api/tree?sort=edited-desc|edited-asc|name`, default `edited-desc`, uses file mtime);
  the choice persists in `localStorage` (`sortMode`). Sort applies to notes within Unfiled and
  within each folder. **Folders follow the toggle too**: in `name` mode alphabetical, otherwise
  ordered by the **latest edit (mtime) of any note in the folder** (empty folders sort oldest).
- **Drag-and-drop** — drag a note onto a folder (or "Unfiled") to move it. Menu move still works.
- **Resizable sidebar** — drag the sidebar/main boundary to resize (160–520px); width persists
  in `localStorage` (`sidebarWidth`). Handled in `App.tsx` (`.sidebar-resizer` overlay).
- **Search** — sidebar search box (debounced ~250ms) hits `GET /api/search?q=`, which walks all
  notes (skips `.trash`) and matches filename + content, returning one-line snippets. Results
  replace the tree while a query is active; clicking opens the note. `⌘K`/`⌘F` focus the box.
- **Autosave + save indicator** — edits auto-write ~1.5s after a typing pause; toolbar shows
  Unsaved changes / Saving… / Saved / Save failed. Manual `⌘S` (and the Save button) still work;
  `beforeunload` warns on unsaved work. Single `saveNow()` in `App.tsx` is the only save path.
- **In-place rename** — editing the title and saving now **renames** the open file (via
  `/api/note/rename`) instead of creating a duplicate. Resolves the old title-vs-rename foot-gun.
- **Last-edited timestamp** — the toolbar shows "Edited <date, time>" under the note title,
  in the viewer's local timezone (`GET /api/note` returns the file `mtime`; refreshed on save).
- **Branding** — inline-SVG app logo (note page + blinking green caret) as the browser favicon
  and beside the "Noter" sidebar title (`client/public/noter-icon.svg`).
- **Keyboard shortcuts** — `⌘S` save, `⌘N` new (blank, unsaved) note, `⌘K`/`⌘F` focus search,
  `Tab` accept autocomplete, `⌘Z` undo a just-accepted autocomplete (in the editor).
- **Persistence** — notes saved under `notes/` as `.md`; folders are subdirectories; trash is
  a hidden `notes/.trash/` + `trash.json` manifest.

Both client (`tsc -b && vite build`) and server (`tsc --noEmit`) typecheck clean. All backend
routes curl-verified, including the path-traversal guard. Drag-and-drop itself has only been
build-verified, not yet click-tested in the browser.

---

## Key decisions

- **Multi-user model** = small team, **admin-created accounts** (no public signup) → a CLI
  (`add-user`) over a signup endpoint/UI. **Auth** = email+password with `crypto.scrypt` (no
  bcrypt dep) + **opaque server-side session tokens** in SQLite (revocable; chosen over stateless
  JWT). Cookie parsed by hand (no `cookie-parser` dep). **Storage** = keep notes on the
  **filesystem**, namespaced `notes/<userId>/` (reuses all existing fs code via a per-user
  `resolveInNotes` root) rather than moving notes into a DB — only users/sessions are in SQLite.
- **LLM under multi-user** = keep `claude -p` under **one shared server login** (zero change to
  `claude.ts`); all users' AI calls flow through it. Tradeoff accepted: shared billing/limits,
  and `--resume` sessionIds aren't namespaced per-user (low risk for a trusted team — ids are
  opaque and returned only to the originating client; documented, not enforced).
- **Export** = Markdown client-side (Blob, zero deps); **PDF server-side** via `md-to-pdf` +
  `github-markdown-css` (per user request) — accepts the Puppeteer/Chromium dependency weight in
  exchange for consistent GitHub-style output, and keeps the client free of print CSS.
- **LLM backend = `claude -p` (Claude Code CLI, headless)**, NOT the Anthropic API. Uses the
  existing Claude Code login — no API key/billing. Swappable later without touching the UI.
  - Autocomplete → `--model sonnet --effort low`; Sanitize → `--model claude-opus-4-8`.
    (`runClaude` now has an `effort` option that maps to `claude -p --effort <level>`:
    `low|medium|high|xhigh|max`.)
  - **Autocomplete latency fix** = disable thinking via `MAX_THINKING_TOKENS=0` in the child
    env (the `--no-extended-thinking` CLI flag does NOT exist in this version — errors as an
    unknown option). This was the dominant latency lever; the CLI process startup and the
    ~6.6k-token default system prompt were not (system-prompt replacement showed no clear win).
  - **DO NOT use `--bare`** — on this enterprise/managed (BCG) account, auth comes through
    Claude Code settings (apiKeyHelper); `--bare` skips settings loading → "Not logged in".
    Confirmed working: `claude -p --model haiku --tools "" --output-format json`.
- **Autocomplete UX** = ghost-text on pause (chosen over inline/always-on).
- **Rendered mode** = `react-markdown` + `remark-gfm` (React nodes, no `dangerouslySetInnerHTML`,
  so no separate XSS sanitization). Mode state lives in `App.tsx` and is passed to `Editor`.
  Default edit on new note; render on open + after sanitize; click rendered view → edit with the
  caret mapped to the clicked source position (best-effort, falls back to the clicked block start).
- **Folders** = single level only (no nesting). **Move UX** = `⋯` menu + drag-and-drop.
  **Recycle bin** = manual restore/purge (no auto-purge by age).
- **Weekly folders** = named by the week's **Monday** date (`YYYY-MM-DD`), chosen over ISO-week
  (`2026-W25`) and human labels ("Week of Jun 16") because it sorts chronologically in the
  alphabetical sidebar and matches the `YYYY-MM-DD-*` note titles. Auto-filing applies only to
  **new top-level** notes (not "+ Note in folder", not existing notes — no retroactive backfill).
- **Folder summary** = ✨ icon on the folder row (chosen over a `⋯` menu for one-click
  discoverability of a headline feature). Output = **preview then save** as a note (vs. copy-only
  or a new note per run); a single living `<folder> Summary.md` overwritten on re-run. One-shot
  (no `QUESTIONS:` loop) — a digest doesn't need sanitize's meaning-preserving Q&A.
- **Saving** = full autosave (debounced) + indicator, chosen over manual-only. **Title** =
  renames the open file in place (not a new file). **Search** = server-side content + filename
  (not client filename-only). **`⌘K`** = focus sidebar search (no separate command palette).
- **Stack** — Vite 6 + React 18 + TypeScript (client, :12345); Node + Express 4 + `tsx watch`
  (server, :23456). Vite dev-proxies `/api` → `:23456`. `concurrently` runs both via `npm run dev`.
- **Path safety** — every fs path built from user input goes through `resolveInNotes()`
  (throws on escape); `safeFileName`/`safeFolderName` sanitize names; `.trash`/dot-folders rejected.
- **Collision safety** — `save`/`rename` no longer silently overwrite. New, unsaved notes save
  via `/api/save` with `createNew:true` → server dedupes through `uniqueName()` (so two same-day
  `…-meeting` notes get `-1`, `-2` rather than clobbering). `/api/note/rename` also dedupes.
  Existing notes always autosave to their own backing file (`current.name`), never a
  title-derived name that could collide with a sibling. The client adopts any deduped name the
  server returns (updates the title) to avoid rename churn.

---

## File roles

### Server (`server/src/`)
- **`index.ts`** — Express app. Routes: `GET /api/health`; `POST /api/autocomplete`;
  `POST /api/sanitize` + `POST /api/sanitize/reply`; `POST /api/folder/summarize` (reads every
  `.md` in the folder except its own `<folder> Summary.md`, builds one prompt, calls Opus with a
  longer `SUMMARIZE_TIMEOUT_MS`) + `POST /api/folder/summarize/reply` (resumes the session to
  steer/revise the digest from a user instruction); `GET /api/search`; file mgmt: `GET /api/tree`, `POST /api/save`,
  `GET /api/note`, `POST /api/note/{create,rename,move,delete}`, `POST /api/folder/{create,rename,delete}`,
  `GET /api/trash`, `POST /api/trash/{restore,delete,empty}`. Holds path/trash helpers
  (`safeFileName`, `safeFolderName`, `resolveInNotes`, `readManifest`/`writeManifest`,
  `makeId`, `uniqueName`, `listMd`). **Now also**: public `GET /api/ping` + `POST /api/login` /
  `POST /api/logout` / `GET /api/me`, then `app.use("/api", requireAuth)` gating all routes below;
  `POST /api/export/pdf` (md-to-pdf); per-user threading — every fs handler starts with
  `userRoot = userRootFor(req.user!.id)` and `resolveInNotes`/`readManifest`/`writeManifest` take
  explicit paths under it; CORS restricted + `trust proxy`; in prod serves `client/dist` + SPA
  fallback. `NOTES_DIR` (imported from `auth.ts`) = `<root>/notes` (the parent of per-user dirs);
  `PORT` = 23456.
- **`claude.ts`** — the ONLY module that talks to the LLM. `runClaude(opts)` spawns `claude -p`
  via `child_process.spawn`. Has an explicit "do NOT use `--bare`" comment. **Unchanged by the
  multi-user work** (runs under the shared server login, user-agnostic).
- **`auth.ts`** — auth + storage roots. Inits SQLite (`users`, `sessions`) at `notes/.noter.db`
  (or `NOTER_DB`); `hashPassword`/`verifyPassword` (scrypt + `timingSafeEqual`); `createUser`,
  `getUserByEmail`; `createSession`/`getSessionUser`/`deleteSession`/`pruneExpiredSessions`;
  `requireAuth` (cookie → `req.user` or 401, + `ensureUserDir`); `readCookie`; exports
  `NOTES_DIR`, `SESSION_COOKIE`, `publicUser`, and augments `Express.Request` with `user`.
- **`add-user.ts`** — admin CLI (`npm run add-user -- <email> <pw> "Name" [--admin]`) → `createUser`
  against the same DB. No signup endpoint/UI.
- **`prompts.ts`** — `AUTOCOMPLETE_SYSTEM`, `SANITIZE_SYSTEM`, `SUMMARIZE_SYSTEM` guardrail
  prompts + the `buildAutocompletePrompt` / `buildSanitizePrompt` / `buildSanitizeReplyPrompt` /
  `buildFolderSummaryPrompt` builders.

### Client (`client/src/`)
- **`App.tsx`** — top-level state: open note `{folder, name}`, title, content, tree, modals,
  `saveState`, search query/results. `refreshTree`, `saveNow` (the single save path: rename-in-
  place + write), debounced autosave + `beforeunload` guard, debounced search, `newNote`, global
  keydown shortcuts, `handleOpen`, `handleCurrentChanged`, `handleAcceptSanitized`. **Now also**
  hosts auth state (`loading`/`out`/`in`): bootstraps via `me()` on mount, registers the 401
  handler, gates the render (spinner → `<Login>` → app), guards the tree load on `auth==="in"`,
  and adds `handleLogout` + the toolbar **.md**/**PDF** export buttons (`pdfBusy`).
- **`Sidebar.tsx`** — `+ Note` / `+ Folder`, collapsible folders, "Unfiled" group, per-note
  `⋯` menu (Rename / Delete / Move to…), per-folder summarize(✨)+add(＋)+rename(✎)+delete,
  recycle-bin row with count. **Adding and renaming** use inline input rows (`InlineInput`
  component; Enter saves, Esc/blur cancels), not `window.prompt`. Create = `creating` state,
  rendered VSCode-style in tree position: `+ Note` → a row in Unfiled, `+ Folder` → a new folder
  row atop Folders, a folder's `＋` → a row inside that (auto-expanded) folder. Rename =
  `renaming` state; the note link / folder name becomes an `InlineInput` (prefilled + selected).
  **Delete** uses `ConfirmDialog` (`dialog` state). Hosts drag-and-drop (note rows draggable;
  folders + Unfiled are drop targets) and the search box + results list (controlled by `App`;
  results replace the tree when a query is active). Footer row shows the signed-in user
  (`user` prop) + a sign-out button (`onLogout`).
- **`Editor.tsx`** — in edit mode: textarea + suggestion bar (debounced autocomplete with
  AbortController); in rendered mode: scrollable `react-markdown`/`remark-gfm` view that switches
  to edit on click — the click maps to a source caret offset (`rehypeSourceOffset`/`data-pos` +
  `caretFromPoint` + `sourceOffsetFromClick`), applied when the textarea mounts. Takes `mode` +
  `onModeChange` props; exports `EditorMode`.
- **`SanitizePanel.tsx`** — modal: loading / questions / preview / error phases; resume loop.
  Preview renders the polished result as Markdown (`react-markdown` + `remark-gfm`, shared
  `.editor-rendered` / `.modal-rendered` styling — same as `SummaryPanel`).
- **`SummaryPanel.tsx`** — folder roll-up modal: loading / preview / error phases; Regenerate /
  Close / Save-to-folder. Preview renders the digest as Markdown (`react-markdown` + `remark-gfm`,
  styled via the shared `.editor-rendered` rules + a `.summary-rendered` container override). A
  steer text box drives Regenerate: with an instruction it calls `refineSummary` (session resume)
  to revise; empty it re-runs a fresh `summarizeFolder`. Keeps a `sessionId` (updated each
  response) and a `reqId` ref to drop stale/post-unmount responses. `App.handleSaveSummary` writes
  the result.
- **`Dialog.tsx`** — `ConfirmDialog`: reusable confirm modal (Enter confirms, Esc/backdrop cancels;
  `danger` prop → red primary button). Used for note/folder delete (Sidebar) and recycle-bin purges.
- **`TrashPanel.tsx`** — modal: list trashed items with Restore / Delete forever / Empty bin.
- **`api.ts`** — typed fetch helpers + `Tree` / `TrashItem` / `Me` types. All paths go via `/api`
  proxy and send `credentials: "include"`. A shared `check(res)` fires a registered
  `setUnauthorizedHandler` on any 401 (→ App shows login). `me`/`login` bypass `check` (their 401
  means "logged out"/"bad credentials", not a dropped session). `exportPdf` returns the PDF blob.
- **`Login.tsx`** — full-screen email+password `<form>` reusing modal/button/input styles;
  loading/disabled + inline error; `onSuccess(user)` lifts state to App.
- **`export.ts`** — `downloadMarkdown(name, md)` (Blob → `<a download>`), `exportNotePdf(name, md)`
  (calls `api.exportPdf` then downloads), `safeFilename`.
- **`styles.css`** — minimal warm palette (cream bg, green accent); sidebar, folders, popover
  menu, drag-over highlight, modal, trash list, spinner.
- **`vite.config.ts`** — react plugin, port 12345, proxy `/api` → `http://localhost:23456`.

### Other
- **`notes/`** — per-user roots `notes/<userId>/` (each with `.md` notes, folder subdirs,
  `.trash/` + `trash.json`) plus the SQLite auth DB `notes/.noter.db` (+ `-wal`/`-shm`). All
  gitignored.
- **`package.json`** (root) — scripts: `dev` (both via concurrently), `dev:server`, `dev:client`,
  `build` (= build:client), `build:client`, `start` (prod), `add-user`, `install:all`. New deps:
  `better-sqlite3`, `md-to-pdf`, `github-markdown-css` (+ `@types/better-sqlite3`).
- Plan/spec lives at `~/.claude/plans/i-want-to-build-humming-gizmo.md`.

---

## Run it

```bash
cd /Users/ethan/code/noter
npm run install:all  # first-time deps (root + client; pulls Chromium for md-to-pdf)
npm run add-user -- you@bcg.com 'password' "Your Name"   # create an account (no signup UI)
npm run dev          # both servers (foreground); open http://localhost:12345 → log in
# individually:
npm run dev:server   # backend  :23456
npm run dev:client   # frontend :12345
# production (one process serves built client + API on :23456, behind a TLS reverse proxy):
npm run build && npm start
```

Background (via `Makefile`):

```bash
make run-bg          # start both in background; logs -> dev.log
make logs            # tail -f dev.log
make kill            # stop whatever's on :12345 / :23456
make run             # foreground run (same as npm run dev)
```

---

## Commit style

Release-style messages. **First line is the version only** (`Release vX.Y.Z`); leave a blank
line, then a short bullet list of what shipped — concise and meaningful, one bullet per
user-facing change. Example:

```
Release v1.1.2

- App logo (favicon + sidebar)
- Last-edited timestamp in header
- Esc returns to preview
```

---

## Open TODOs

- [ ] **Browser click-through** of the new auth + export flows (login screen, wrong-password
      error, logout, mid-session 401 bounce, `.md`/PDF buttons) — curl-verified end-to-end, not
      yet clicked in the browser.
- [ ] **Legacy notes migration** — old flat `notes/*.md` (if any) are not auto-moved into a user
      dir; document the manual `mv notes/*.md notes/<id>/` step or add an `add-user --claim-legacy`.
- [ ] **Optional hardening (not built, trusted-team assumption)**: rate-limit `/api/login`;
      namespace/verify `--resume` sessionId ownership (store `sessionId→user_id`) if the trust
      model tightens. Read the cleartext password off a hidden prompt in `add-user` instead of argv.
- [ ] **Browser click-test drag-and-drop** (only build-verified so far).
- [ ] **Browser click-through** of ghost-text accept (Tab) and the Sanitize modal
      (questions + preview) — never done interactively.
- [x] ~~Title-field Save creates a new file rather than renaming in place~~ — resolved:
      `saveNow()` now renames the open file in place when the title changes.
- [ ] Browser click-test of the new features (search results, autosave indicator transitions,
      `⌘N`/`⌘S`/`⌘K` shortcuts) — build- and curl-verified, not yet exercised in the browser.
- [ ] Browser click-test **folder summarize** (✨ → preview → steer/Regenerate → Save). The
      endpoints are curl-verified end-to-end (real Opus run, steered refine over a session,
      self-inclusion guard); the modal/icon and steer box aren't yet clicked in the browser.
- [ ] No tests yet (personal v1). Add endpoint tests if it grows.

## Next steps

1. `npm run add-user …`, then `npm run dev` and click through the browser: log in, create/edit
   notes, sanitize, summarize, `.md` + PDF export, logout. Confirm a second account is isolated.
2. Decide hosting: build + `npm start` behind a TLS-terminating reverse proxy (Caddy/nginx) so
   `secure` cookies work (`trust proxy` is already on). Optionally add a Dockerfile.
