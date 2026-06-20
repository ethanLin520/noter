# Noter — Progress

Local, personal note-taking app for work meetings. Type fast/shorthand notes, get
real-time autocomplete corrections and a post-meeting "sanitize" polish. Notes are saved
as `.md` files on disk. Local-only, single-user, no auth, no deploy.

_Last updated: 2026-06-20 (v1.1.2) — added an app logo (favicon + sidebar), a last-edited timestamp in the toolbar header, and Esc-to-preview in edit mode. Also cut autocomplete latency ~2-4x by disabling thinking (`MAX_THINKING_TOKENS=0`) on the haiku call. Details in **Current state** below._

---

## Current state

Working and verified end-to-end:

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
  snapshot so native undo resumes). **Thinking disabled for speed**: the autocomplete
  `claude -p` call runs with `MAX_THINKING_TOKENS=0` (via `runClaude`'s `disableThinking`
  option, which sets it in the child env). Haiku was emitting ~130 hidden thinking tokens for
  a ~5-token answer; disabling it cut per-call API time from ~1.5-4s to ~0.9s (warm endpoint
  ~1.3s) with identical output. Sanitize/summarize keep thinking on.
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
- **Note sorting** — notes sort by **creation date, newest first** by default. A small button in
  the sidebar actions cycles the order: Newest first (`↓`) → Oldest first (`↑`) → Name A–Z (`A`).
  Server-side (`GET /api/tree?sort=created-desc|created-asc|name`, default `created-desc`, uses
  file birthtime); the choice persists in `localStorage` (`sortMode`). Folders themselves stay
  name-sorted; sort applies to notes within Unfiled and within each folder.
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

- **LLM backend = `claude -p` (Claude Code CLI, headless)**, NOT the Anthropic API. Uses the
  existing Claude Code login — no API key/billing. Swappable later without touching the UI.
  - Autocomplete → `--model haiku`; Sanitize → `--model claude-opus-4-8`.
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
  `makeId`, `uniqueName`, `listMd`). `NOTES_DIR` = `<root>/notes`, `PORT` = 23456.
- **`claude.ts`** — the ONLY module that talks to the LLM. `runClaude(opts)` spawns `claude -p`
  via `child_process.spawn`. Has an explicit "do NOT use `--bare`" comment.
- **`prompts.ts`** — `AUTOCOMPLETE_SYSTEM`, `SANITIZE_SYSTEM`, `SUMMARIZE_SYSTEM` guardrail
  prompts + the `buildAutocompletePrompt` / `buildSanitizePrompt` / `buildSanitizeReplyPrompt` /
  `buildFolderSummaryPrompt` builders.

### Client (`client/src/`)
- **`App.tsx`** — top-level state: open note `{folder, name}`, title, content, tree, modals,
  `saveState`, search query/results. `refreshTree`, `saveNow` (the single save path: rename-in-
  place + write), debounced autosave + `beforeunload` guard, debounced search, `newNote`, global
  keydown shortcuts, `handleOpen`, `handleCurrentChanged`, `handleAcceptSanitized`.
- **`Sidebar.tsx`** — `+ Note` / `+ Folder`, collapsible folders, "Unfiled" group, per-note
  `⋯` menu (Rename / Delete / Move to…), per-folder summarize(✨)+add(＋)+rename(✎)+delete,
  recycle-bin row with count. **Adding and renaming** use inline input rows (`InlineInput`
  component; Enter saves, Esc/blur cancels), not `window.prompt`. Create = `creating` state,
  rendered VSCode-style in tree position: `+ Note` → a row in Unfiled, `+ Folder` → a new folder
  row atop Folders, a folder's `＋` → a row inside that (auto-expanded) folder. Rename =
  `renaming` state; the note link / folder name becomes an `InlineInput` (prefilled + selected).
  **Delete** uses `ConfirmDialog` (`dialog` state). Hosts drag-and-drop (note rows draggable;
  folders + Unfiled are drop targets) and the search box + results list (controlled by `App`;
  results replace the tree when a query is active).
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

1. Run `npm run dev` and manually exercise: type→pause→Tab; sanitize a note; create/rename/
   move (menu + drag)/delete; restore + empty bin; confirm legacy flat note opens.
2. Resolve the title-vs-rename behavior decision above.
