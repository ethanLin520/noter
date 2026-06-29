import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type EditorMode } from "./Editor";
import SanitizePanel from "./SanitizePanel";
import Sidebar from "./Sidebar";
import SummaryPanel from "./SummaryPanel";
import TrashPanel from "./TrashPanel";
import {
  getTree,
  loadNote,
  logout,
  me,
  renameNote,
  saveNote,
  searchNotes,
  setUnauthorizedHandler,
  type Me,
  type SearchResult,
  type SortMode,
  type Tree,
} from "./api";
import Login from "./Login";
import { downloadMarkdown, exportNotePdf } from "./export";

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

interface OpenNote {
  folder: string;
  name: string;
}

type AuthState =
  | { status: "loading" }
  | { status: "out" }
  | { status: "in"; user: Me };

function defaultTitle(): string {
  const d = new Date();
  const date = d.toISOString().slice(0, 10);
  return `${date}-meeting`;
}

const stripExt = (name: string) => name.replace(/\.md$/i, "");

/** "Jun 20, 2026, 11:08 AM" — absolute last-edited stamp for the header. */
function formatEdited(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const EMPTY_TREE: Tree = { unfiled: [], folders: [], trashCount: 0 };

const SAVE_LABEL: Record<SaveState, string> = {
  idle: "",
  dirty: "Unsaved changes",
  saving: "Saving…",
  saved: "Saved",
  error: "Save failed",
};

const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 520;
const SIDEBAR_DEFAULT = 220;

function initialSidebarWidth(): number {
  const stored = Number(localStorage.getItem("sidebarWidth"));
  if (Number.isFinite(stored) && stored >= SIDEBAR_MIN && stored <= SIDEBAR_MAX) {
    return stored;
  }
  return SIDEBAR_DEFAULT;
}

function initialSortMode(): SortMode {
  const stored = localStorage.getItem("sortMode");
  return stored === "edited-asc" || stored === "name" ? stored : "edited-desc";
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [pdfBusy, setPdfBusy] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const dragging = useRef(false);
  const [title, setTitle] = useState(defaultTitle());
  const [notes, setNotes] = useState("");
  const [current, setCurrent] = useState<OpenNote | null>(null);
  // ISO timestamp of the open note's last save; null for an unsaved new note.
  const [lastEdited, setLastEdited] = useState<string | null>(null);
  const [tree, setTree] = useState<Tree>(EMPTY_TREE);
  const [sortMode, setSortMode] = useState<SortMode>(initialSortMode);
  const [showSanitize, setShowSanitize] = useState(false);
  const [summaryFolder, setSummaryFolder] = useState<string | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  const [status, setStatus] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [mode, setMode] = useState<EditorMode>("edit");

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Guards against overlapping autosaves; a save requested mid-flight re-runs after.
  const inFlight = useRef(false);
  const dirtyAgain = useRef(false);

  const refreshTree = useCallback(() => {
    getTree(sortMode)
      .then(setTree)
      .catch(() => setTree(EMPTY_TREE));
  }, [sortMode]);

  // Auth bootstrap: check the session once on mount; register the global 401 hook
  // so an expired session anywhere drops the app back to the login screen.
  useEffect(() => {
    setUnauthorizedHandler(() => setAuth({ status: "out" }));
    let alive = true;
    me()
      .then((u) => {
        if (alive) setAuth(u ? { status: "in", user: u } : { status: "out" });
      })
      .catch(() => {
        if (alive) setAuth({ status: "out" });
      });
    return () => {
      alive = false;
      setUnauthorizedHandler(null);
    };
  }, []);

  // Load the tree once authenticated (and whenever the sort changes).
  useEffect(() => {
    if (auth.status === "in") refreshTree();
  }, [auth.status, refreshTree]);

  const changeSort = useCallback((next: SortMode) => {
    setSortMode(next);
    localStorage.setItem("sortMode", next);
  }, []);

  useEffect(() => {
    localStorage.setItem("sidebarWidth", String(sidebarWidth));
  }, [sidebarWidth]);

  const startResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: PointerEvent) => {
      if (!dragging.current) return;
      const w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, ev.clientX));
      setSidebarWidth(w);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  const flash = useCallback((msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus(""), 2500);
  }, []);

  const saveNow = useCallback(async () => {
    // Nothing to persist yet: empty editor with no backing file.
    if (notes.trim().length === 0 && !current) return;
    if (inFlight.current) {
      dirtyAgain.current = true;
      return;
    }
    inFlight.current = true;
    setSaveState("saving");
    try {
      let active = current;
      const desired = title.trim();
      if (active) {
        // Rename in place when the title changed — don't orphan the old file.
        // The server dedupes, so adopt whatever name it returns to avoid churn.
        if (desired && desired !== stripExt(active.name)) {
          const { folder, name } = await renameNote(active.folder, active.name, desired);
          active = { folder, name };
          setCurrent(active);
          if (stripExt(name) !== desired) setTitle(stripExt(name));
        }
        // Save to the note's actual file, never a title-derived name (could be a sibling).
        await saveNote(active.folder, stripExt(active.name), notes);
      } else {
        // Brand-new note: create under a unique name so we never clobber an existing file.
        // Top-level new notes are filed as unfiled.
        const { folder, name } = await saveNote("", desired || "untitled", notes, true);
        active = { folder, name };
        setCurrent(active);
        if (stripExt(name) !== desired) setTitle(stripExt(name));
      }
      setSaveState("saved");
      setLastEdited(new Date().toISOString());
      refreshTree();
    } catch (e) {
      setSaveState("error");
      flash(`Save failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      inFlight.current = false;
      if (dirtyAgain.current) {
        dirtyAgain.current = false;
        saveNowRef.current?.();
      }
    }
  }, [current, title, notes, refreshTree, flash]);

  // Keep a stable ref to the latest saveNow for timers/listeners.
  const saveNowRef = useRef(saveNow);
  useEffect(() => {
    saveNowRef.current = saveNow;
  }, [saveNow]);

  // Autosave: after a typing pause, persist dirty edits.
  useEffect(() => {
    if (saveState !== "dirty") return;
    const t = window.setTimeout(() => saveNowRef.current?.(), 1500);
    return () => window.clearTimeout(t);
  }, [saveState, notes, title]);

  // Warn before leaving with unsaved work.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (saveState === "dirty" || saveState === "saving") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveState]);

  // Start a fresh, unsaved note (file is created on first autosave).
  const newNote = useCallback(() => {
    setCurrent(null);
    setTitle(defaultTitle());
    setNotes("");
    setSaveState("idle");
    setMode("edit");
    setLastEdited(null);
  }, []);

  // Global keyboard shortcuts: ⌘S save, ⌘N new, ⌘K/⌘F focus search.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        saveNowRef.current?.();
      } else if (k === "n") {
        e.preventDefault();
        newNote();
      } else if (k === "k" || k === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [newNote]);

  // Debounced search across notes.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResults([]);
      return;
    }
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      searchNotes(q, ctrl.signal)
        .then(setSearchResults)
        .catch(() => {
          /* ignore (abort or transient error) */
        });
    }, 250);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [searchQuery]);

  const handleNotesChange = useCallback((next: string) => {
    setNotes(next);
    setSaveState("dirty");
  }, []);

  const handleOpen = useCallback(
    async (folder: string, name: string) => {
      try {
        const { markdown: md, mtime } = await loadNote(folder, name);
        setNotes(md);
        setTitle(stripExt(name));
        setCurrent({ folder, name });
        setLastEdited(mtime);
        setSaveState("idle"); // freshly loaded — not dirty
        setMode("rendered"); // notes are usually read before edited
        flash(`Opened ${stripExt(name)}`);
      } catch (e) {
        flash(`Open failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    [flash],
  );

  // Called by the sidebar when the open note is renamed/moved/deleted.
  const handleCurrentChanged = useCallback((next: OpenNote | null) => {
    setCurrent(next);
    setSaveState("idle");
    if (next) {
      setTitle(stripExt(next.name));
    } else {
      setTitle(defaultTitle());
      setNotes("");
      setMode("edit");
      setLastEdited(null);
    }
  }, []);

  const handleAcceptSanitized = useCallback(
    async (markdown: string) => {
      setNotes(markdown);
      setShowSanitize(false);
      setMode("rendered"); // show the polished result formatted
      setSaveState("saving");
      try {
        let name: string;
        if (current) {
          // Existing note: overwrite its own file in place.
          ({ name } = await saveNote(current.folder, stripExt(current.name), markdown));
        } else {
          // Brand-new note: create under a unique name to avoid clobbering a sibling.
          // Top-level new notes are filed as unfiled.
          const saved = await saveNote("", title.trim() || "untitled", markdown, true);
          name = saved.name;
          setCurrent({ folder: saved.folder, name });
          if (stripExt(name) !== title.trim()) setTitle(stripExt(name));
        }
        setSaveState("saved");
        setLastEdited(new Date().toISOString());
        flash(`Sanitized & saved ${stripExt(name)}`);
        refreshTree();
      } catch (e) {
        setSaveState("error");
        flash(`Saved to editor, but file save failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    [current, title, refreshTree, flash],
  );

  // Save a folder roll-up as a note inside that folder, then open it.
  const handleSaveSummary = useCallback(
    async (markdown: string) => {
      const folder = summaryFolder;
      if (!folder) return;
      setSummaryFolder(null);
      try {
        const { folder: f, name } = await saveNote(folder, `${folder} Summary`, markdown);
        refreshTree();
        await handleOpen(f, name);
        flash(`Saved ${stripExt(name)}`);
      } catch (e) {
        flash(`Summary save failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    [summaryFolder, refreshTree, handleOpen, flash],
  );

  const handleLogout = useCallback(async () => {
    await logout();
    setAuth({ status: "out" });
  }, []);

  const handleExportPdf = useCallback(async () => {
    setPdfBusy(true);
    try {
      await exportNotePdf(title, notes);
    } catch (e) {
      flash(`PDF export failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setPdfBusy(false);
    }
  }, [title, notes, flash]);

  // Auth gate (all hooks above run first). loading → spinner; out → login.
  if (auth.status === "loading") {
    return (
      <div className="login-screen">
        <div className="spinner" />
      </div>
    );
  }
  if (auth.status === "out") {
    return <Login onSuccess={(user) => setAuth({ status: "in", user })} />;
  }

  return (
    <div className="app" style={{ gridTemplateColumns: `${sidebarWidth}px 1fr` }}>
      <Sidebar
        tree={tree}
        current={current}
        user={auth.user}
        onLogout={handleLogout}
        onOpen={handleOpen}
        onOpenTrash={() => setShowTrash(true)}
        reload={refreshTree}
        onCurrentChanged={handleCurrentChanged}
        onSummarizeFolder={setSummaryFolder}
        flash={flash}
        sortMode={sortMode}
        onChangeSort={changeSort}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        searchResults={searchResults}
        searchInputRef={searchInputRef}
      />

      <div
        className="sidebar-resizer"
        style={{ left: `${sidebarWidth}px` }}
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
      />

      <main className="main">
        <header className="toolbar">
          <div className="title-block">
            <input
              className="title-input"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setSaveState("dirty");
              }}
              placeholder="note title"
              aria-label="Note title"
            />
            {lastEdited && (
              <span className="title-edited">Edited {formatEdited(lastEdited)}</span>
            )}
          </div>
          <div className="toolbar-actions">
            <span className="status">{status}</span>
            <span className={`save-indicator ${saveState}`}>{SAVE_LABEL[saveState]}</span>
            {current && (
              <span className="muted small" title="Current location">
                {current.folder || "Unfiled"}
              </span>
            )}
            <button
              className="btn-secondary"
              onClick={() => setMode((m) => (m === "edit" ? "rendered" : "edit"))}
              title={mode === "edit" ? "Preview rendered Markdown" : "Back to editing"}
            >
              {mode === "edit" ? "Preview" : "Edit"}
            </button>
            <button
              className="btn-secondary"
              onClick={() => downloadMarkdown(title, notes)}
              disabled={notes.trim().length === 0}
              title="Download as Markdown (.md)"
            >
              .md
            </button>
            <button
              className="btn-secondary"
              onClick={handleExportPdf}
              disabled={notes.trim().length === 0 || pdfBusy}
              title="Export as PDF"
            >
              {pdfBusy ? "PDF…" : "PDF"}
            </button>
            <button className="btn-secondary" onClick={() => saveNow()}>
              Save
            </button>
            <button
              className="btn-primary"
              onClick={() => setShowSanitize(true)}
              disabled={notes.trim().length === 0}
              title={notes.trim().length === 0 ? "Type some notes first" : "Polish the whole note"}
            >
              Sanitize
            </button>
          </div>
        </header>

        <Editor value={notes} onChange={handleNotesChange} mode={mode} onModeChange={setMode} />
      </main>

      {showSanitize && (
        <SanitizePanel
          notes={notes}
          onAccept={handleAcceptSanitized}
          onClose={() => setShowSanitize(false)}
        />
      )}

      {summaryFolder && (
        <SummaryPanel
          folder={summaryFolder}
          onSave={handleSaveSummary}
          onClose={() => setSummaryFolder(null)}
        />
      )}

      {showTrash && (
        <TrashPanel onChanged={refreshTree} onClose={() => setShowTrash(false)} />
      )}
    </div>
  );
}
