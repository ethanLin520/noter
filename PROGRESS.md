# Noter — Progress

Local, personal note-taking app for work meetings. Type fast/shorthand notes, get
real-time autocomplete corrections and a post-meeting "sanitize" polish. Notes are saved
as `.md` files on disk. Local-only, single-user, no auth, no deploy.

_Last updated: 2026-06-16 — added folder rename (`POST /api/folder/rename`, `renameFolder` helper, ✎ button on the folder row); errors on name collision, sanitizes via `safeFolderName`, updates the open note's folder if affected_

---

## Current state

Working and verified end-to-end:

- **Real-time autocomplete** — ghost-text-on-pause (~900ms debounce). Suggestion shows in a
  bar below the editor; Tab accepts, Esc dismisses. Minimal corrections only (typos,
  abbreviations) — never invents content.
- **Rendered (read) mode** — formatted-Markdown view (`react-markdown` + `remark-gfm`) shown
  alongside the raw textarea. A toolbar **Preview/Edit** toggle switches between them. Notes open
  in rendered mode and auto-switch to rendered after a sanitize; new blank notes start in edit
  mode. Clicking the rendered view drops into edit mode with the caret at the clicked spot (a
  `rehypeSourceOffset` plugin stamps `data-pos` offsets; the click maps back via `caretFromPoint`
  + a block-anchored text search).
- **Post-meeting sanitize** — stronger model polishes the whole note into Markdown without
  changing meaning; asks clarifying questions via a `QUESTIONS:` block (multi-turn resume loop)
  rather than guessing.
- **Note & folder management** — create / rename / move / delete notes; create / rename / delete
  single-level folders (rename errors on name collision, no merge); recycle bin with restore /
  permanent-delete / empty-bin (manual, nothing auto-purges).
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
- **Keyboard shortcuts** — `⌘S` save, `⌘N` new (blank, unsaved) note, `⌘K`/`⌘F` focus search.
- **Persistence** — notes saved under `notes/` as `.md`; folders are subdirectories; trash is
  a hidden `notes/.trash/` + `trash.json` manifest.

Both client (`tsc -b && vite build`) and server (`tsc --noEmit`) typecheck clean. All backend
routes curl-verified, including the path-traversal guard. Drag-and-drop itself has only been
build-verified, not yet click-tested in the browser.

---

## Key decisions

- **LLM backend = `claude -p` (Claude Code CLI, headless)**, NOT the Anthropic API. Uses the
  existing Claude Code login — no API key/billing. Swappable later without touching the UI.
  - Autocomplete → `--model haiku`; Sanitize → `--model claude-opus-4-8`.
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
  `POST /api/sanitize` + `POST /api/sanitize/reply`; `GET /api/search`; file mgmt: `GET /api/tree`, `POST /api/save`,
  `GET /api/note`, `POST /api/note/{create,rename,move,delete}`, `POST /api/folder/{create,rename,delete}`,
  `GET /api/trash`, `POST /api/trash/{restore,delete,empty}`. Holds path/trash helpers
  (`safeFileName`, `safeFolderName`, `resolveInNotes`, `readManifest`/`writeManifest`,
  `makeId`, `uniqueName`, `listMd`). `NOTES_DIR` = `<root>/notes`, `PORT` = 23456.
- **`claude.ts`** — the ONLY module that talks to the LLM. `runClaude(opts)` spawns `claude -p`
  via `child_process.spawn`. Has an explicit "do NOT use `--bare`" comment.
- **`prompts.ts`** — `AUTOCOMPLETE_SYSTEM`, `SANITIZE_SYSTEM` guardrail prompts + the
  `buildAutocompletePrompt` / `buildSanitizePrompt` / `buildSanitizeReplyPrompt` builders.

### Client (`client/src/`)
- **`App.tsx`** — top-level state: open note `{folder, name}`, title, content, tree, modals,
  `saveState`, search query/results. `refreshTree`, `saveNow` (the single save path: rename-in-
  place + write), debounced autosave + `beforeunload` guard, debounced search, `newNote`, global
  keydown shortcuts, `handleOpen`, `handleCurrentChanged`, `handleAcceptSanitized`.
- **`Sidebar.tsx`** — `+ Note` / `+ Folder`, collapsible folders, "Unfiled" group, per-note
  `⋯` menu (Rename / Delete / Move to…), per-folder add+rename(✎)+delete, recycle-bin row with count.
  Hosts drag-and-drop (note rows draggable; folders + Unfiled are drop targets) and the search
  box + results list (controlled by `App`; results replace the tree when a query is active).
- **`Editor.tsx`** — in edit mode: textarea + suggestion bar (debounced autocomplete with
  AbortController); in rendered mode: scrollable `react-markdown`/`remark-gfm` view that switches
  to edit on click — the click maps to a source caret offset (`rehypeSourceOffset`/`data-pos` +
  `caretFromPoint` + `sourceOffsetFromClick`), applied when the textarea mounts. Takes `mode` +
  `onModeChange` props; exports `EditorMode`.
- **`SanitizePanel.tsx`** — modal: loading / questions / preview / error phases; resume loop.
- **`TrashPanel.tsx`** — modal: list trashed items with Restore / Delete forever / Empty bin.
- **`api.ts`** — typed fetch helpers + `Tree` / `TrashItem` types. All paths go via `/api` proxy.
- **`styles.css`** — minimal warm palette (cream bg, green accent); sidebar, folders, popover
  menu, drag-over highlight, modal, trash list, spinner.
- **`vite.config.ts`** — react plugin, port 12345, proxy `/api` → `http://localhost:23456`.

### Other
- **`notes/`** — saved notes (`.md`), folders (subdirs), `.trash/` recycle bin + `trash.json`.
- **`package.json`** (root) — scripts: `dev` (both via concurrently), `dev:server`, `dev:client`,
  `build:client`, `install:all`.
- Plan/spec lives at `~/.claude/plans/i-want-to-build-humming-gizmo.md`.

---

## Run it

```bash
cd /Users/linethan/code/noter
npm run dev          # both servers (foreground); open http://localhost:12345
# individually:
npm run dev:server   # backend  :23456
npm run dev:client   # frontend :12345
# first-time deps:
npm run install:all
```

Background (via `Makefile`):

```bash
make run-bg          # start both in background; logs -> dev.log
make logs            # tail -f dev.log
make kill            # stop whatever's on :12345 / :23456
make run             # foreground run (same as npm run dev)
```

---

## Open TODOs

- [ ] **Browser click-test drag-and-drop** (only build-verified so far).
- [ ] **Browser click-through** of ghost-text accept (Tab) and the Sanitize modal
      (questions + preview) — never done interactively.
- [x] ~~Title-field Save creates a new file rather than renaming in place~~ — resolved:
      `saveNow()` now renames the open file in place when the title changes.
- [ ] Browser click-test of the new features (search results, autosave indicator transitions,
      `⌘N`/`⌘S`/`⌘K` shortcuts) — build- and curl-verified, not yet exercised in the browser.
- [ ] No tests yet (personal v1). Add endpoint tests if it grows.

## Next steps

1. Run `npm run dev` and manually exercise: type→pause→Tab; sanitize a note; create/rename/
   move (menu + drag)/delete; restore + empty bin; confirm legacy flat note opens.
2. Resolve the title-vs-rename behavior decision above.
