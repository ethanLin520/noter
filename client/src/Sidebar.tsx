import { type RefObject, useState } from "react";
import { ConfirmDialog } from "./Dialog";
import {
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  moveNote,
  renameFolder,
  renameNote,
  type Me,
  type SearchResult,
  type SortMode,
  type Tree,
} from "./api";

interface OpenNote {
  folder: string;
  name: string;
}

interface SidebarProps {
  tree: Tree;
  current: OpenNote | null;
  /** The signed-in user (shown in the footer with a logout control). */
  user: Me | null;
  onLogout: () => void;
  onOpen: (folder: string, name: string) => void;
  onOpenTrash: () => void;
  /** Re-fetch the tree after a mutation. */
  reload: () => void;
  /** Notify App that the open note moved/renamed/was deleted. */
  onCurrentChanged: (next: OpenNote | null) => void;
  /** Open the folder-summary modal for `folder`. */
  onSummarizeFolder: (folder: string) => void;
  flash: (msg: string) => void;
  sortMode: SortMode;
  onChangeSort: (next: SortMode) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  searchResults: SearchResult[];
  searchInputRef: RefObject<HTMLInputElement>;
}

const stripExt = (name: string) => name.replace(/\.md$/i, "");

// Click the sort button to cycle through these in order.
const SORT_CYCLE: SortMode[] = ["edited-desc", "edited-asc", "name"];
const SORT_META: Record<SortMode, { label: string; icon: string }> = {
  "edited-desc": { label: "Last edited", icon: "↓" },
  "edited-asc": { label: "Least recently edited", icon: "↑" },
  name: { label: "Name (A–Z)", icon: "A" },
};

/** Inline text row for creating/renaming a note/folder in place. Enter submits, Esc/blur cancels. */
function InlineInput({
  placeholder,
  initial = "",
  onSubmit,
  onCancel,
}: {
  placeholder?: string;
  initial?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <input
      className="inline-input"
      autoFocus
      placeholder={placeholder}
      value={value}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onCancel()}
    />
  );
}

export default function Sidebar({
  tree,
  current,
  user,
  onLogout,
  onOpen,
  onOpenTrash,
  reload,
  onCurrentChanged,
  onSummarizeFolder,
  flash,
  sortMode,
  onChangeSort,
  searchQuery,
  onSearchChange,
  searchResults,
  searchInputRef,
}: SidebarProps) {
  // Folders default to expanded.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // Which note's "..." menu is open, keyed by `folder/name`.
  const [menuKey, setMenuKey] = useState<string | null>(null);
  // Drop target currently hovered during a drag ("" = Unfiled, folder name, or null).
  const [dragOver, setDragOver] = useState<string | null>(null);
  // In-progress inline creation. null = nothing; folder "" = top-level.
  const [creating, setCreating] = useState<
    { kind: "note" | "folder"; folder: string } | null
  >(null);
  // In-progress inline rename. null = nothing. For a note, folder is its parent.
  const [renaming, setRenaming] = useState<
    { kind: "note"; folder: string; name: string } | { kind: "folder"; name: string } | null
  >(null);
  // Active confirm dialog (delete), or null when none is open.
  const [dialog, setDialog] = useState<
    { title: string; message: string; onConfirm: () => void } | null
  >(null);

  const folderNames = tree.folders.map((f) => f.name);

  const toggle = (name: string) =>
    setCollapsed((c) => ({ ...c, [name]: !c[name] }));

  const isOpen = (folder: string, name: string) =>
    current?.folder === folder && current?.name === name;

  const closeMenu = () => setMenuKey(null);

  const wrap = async (fn: () => Promise<void>, fail: string) => {
    try {
      await fn();
    } catch (e) {
      flash(`${fail}: ${e instanceof Error ? e.message : e}`);
    }
  };

  // Open an inline input. For a note in a folder, force that folder expanded.
  const handleNewNote = (folder: string) => {
    if (folder) setCollapsed((c) => ({ ...c, [folder]: false }));
    setCreating({ kind: "note", folder });
  };

  const handleNewFolder = () => setCreating({ kind: "folder", folder: "" });

  const submitNote = (folder: string, raw: string) => {
    setCreating(null);
    // Top-level new notes are filed as unfiled; an explicit
    // "+ Note in folder" keeps the folder the user chose.
    wrap(async () => {
      const { folder: f, name } = await createNote(folder, raw.trim() || "untitled");
      reload();
      onOpen(f, name);
    }, "Create failed");
  };

  const submitFolder = (raw: string) => {
    setCreating(null);
    const trimmed = raw.trim();
    if (!trimmed) return;
    wrap(async () => {
      await createFolder(trimmed);
      reload();
    }, "Create folder failed");
  };

  const handleRename = (folder: string, name: string) => {
    closeMenu();
    setRenaming({ kind: "note", folder, name });
  };

  const submitRenameNote = (folder: string, name: string, raw: string) => {
    setRenaming(null);
    const trimmed = raw.trim();
    if (!trimmed || trimmed === stripExt(name)) return;
    wrap(async () => {
      const { name: newName } = await renameNote(folder, name, trimmed);
      reload();
      if (isOpen(folder, name)) onCurrentChanged({ folder, name: newName });
      flash(`Renamed to ${stripExt(newName)}`);
    }, "Rename failed");
  };

  const handleMove = (folder: string, name: string, toFolder: string) =>
    wrap(async () => {
      closeMenu();
      const { folder: f, name: n } = await moveNote(folder, name, toFolder);
      reload();
      if (isOpen(folder, name)) onCurrentChanged({ folder: f, name: n });
      flash(toFolder ? `Moved to ${toFolder}` : "Moved to Unfiled");
    }, "Move failed");

  const handleDelete = (folder: string, name: string) => {
    closeMenu();
    setDialog({
      title: "Delete note",
      message: `Move "${stripExt(name)}" to the recycle bin?`,
      onConfirm: () => {
        setDialog(null);
        wrap(async () => {
          await deleteNote(folder, name);
          reload();
          if (isOpen(folder, name)) onCurrentChanged(null);
          flash("Moved to recycle bin");
        }, "Delete failed");
      },
    });
  };

  // --- Drag and drop: move a note onto a folder (or Unfiled) ---------------
  const DRAG_MIME = "application/x-noter";

  const onNoteDragStart = (e: React.DragEvent, folder: string, name: string) => {
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ folder, name }));
    e.dataTransfer.effectAllowed = "move";
    closeMenu();
  };

  /** Props that make an element a drop target for `targetFolder` ("" = Unfiled). */
  const dropProps = (targetFolder: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOver(targetFolder);
    },
    onDragLeave: () => setDragOver((t) => (t === targetFolder ? null : t)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      const raw = e.dataTransfer.getData(DRAG_MIME);
      if (!raw) return;
      try {
        const { folder, name } = JSON.parse(raw) as { folder: string; name: string };
        if (folder === targetFolder) return; // already here
        handleMove(folder, name, targetFolder);
      } catch {
        /* ignore malformed payloads */
      }
    },
  });

  const handleRenameFolder = (name: string) => {
    closeMenu();
    setRenaming({ kind: "folder", name });
  };

  const submitRenameFolder = (name: string, raw: string) => {
    setRenaming(null);
    const trimmed = raw.trim();
    if (!trimmed || trimmed === name) return;
    wrap(async () => {
      const { name: newName } = await renameFolder(name, trimmed);
      reload();
      if (current?.folder === name) onCurrentChanged({ folder: newName, name: current.name });
      flash(`Renamed folder to ${newName}`);
    }, "Rename folder failed");
  };

  const handleDeleteFolder = (name: string, noteCount: number) => {
    closeMenu();
    setDialog({
      title: "Delete folder",
      message:
        noteCount > 0
          ? `Delete folder "${name}"? Its ${noteCount} note(s) will go to the recycle bin.`
          : `Delete empty folder "${name}"?`,
      onConfirm: () => {
        setDialog(null);
        wrap(async () => {
          await deleteFolder(name);
          reload();
          if (current?.folder === name) onCurrentChanged(null);
          flash(`Deleted folder ${name}`);
        }, "Delete folder failed");
      },
    });
  };

  const renderNote = (folder: string, name: string) => {
    const key = `${folder}/${name}`;
    const moveTargets = ["", ...folderNames].filter((f) => f !== folder);
    const isRenaming =
      renaming?.kind === "note" && renaming.folder === folder && renaming.name === name;
    if (isRenaming) {
      return (
        <li key={key} className="note-row">
          <InlineInput
            initial={stripExt(name)}
            onSubmit={(v) => submitRenameNote(folder, name, v)}
            onCancel={() => setRenaming(null)}
          />
        </li>
      );
    }
    return (
      <li
        key={key}
        className="note-row"
        draggable
        onDragStart={(e) => onNoteDragStart(e, folder, name)}
      >
        <button
          className={`note-link${isOpen(folder, name) ? " active" : ""}`}
          onClick={() => onOpen(folder, name)}
          title={name}
        >
          {stripExt(name)}
        </button>
        <button
          className="icon-btn"
          title="Note actions"
          onClick={() => setMenuKey(menuKey === key ? null : key)}
        >
          ⋯
        </button>
        {menuKey === key && (
          <div className="popover" onMouseLeave={closeMenu}>
            <button className="popover-item" onClick={() => handleRename(folder, name)}>
              Rename
            </button>
            <button className="popover-item" onClick={() => handleDelete(folder, name)}>
              Delete
            </button>
            <div className="popover-label">Move to</div>
            {moveTargets.map((t) => (
              <button
                key={t || "__unfiled"}
                className="popover-item indent"
                onClick={() => handleMove(folder, name, t)}
              >
                {t || "Unfiled"}
              </button>
            ))}
          </div>
        )}
      </li>
    );
  };

  return (
    <aside className="sidebar">
      <h1 className="logo">
        <img className="logo-icon" src="/noter-icon.svg" alt="" aria-hidden="true" />
        Noter
      </h1>

      <div className="sidebar-actions">
        <button className="btn-secondary small" onClick={() => handleNewNote("")}>
          + Note
        </button>
        <button className="btn-secondary small" onClick={handleNewFolder}>
          + Folder
        </button>
        <button
          className="btn-secondary small sort-btn"
          title={`Sort: ${SORT_META[sortMode].label} (click to change)`}
          onClick={() =>
            onChangeSort(
              SORT_CYCLE[(SORT_CYCLE.indexOf(sortMode) + 1) % SORT_CYCLE.length],
            )
          }
        >
          {SORT_META[sortMode].icon}
        </button>
      </div>

      <div className="search-box">
        <input
          ref={searchInputRef}
          className="search-input"
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search notes (⌘K)"
          aria-label="Search notes"
        />
        {searchQuery && (
          <button
            className="search-clear"
            title="Clear search"
            onClick={() => onSearchChange("")}
          >
            ✕
          </button>
        )}
      </div>

      {searchQuery.trim() ? (
        <ul className="search-results">
          {searchResults.length === 0 && <li className="muted small empty">No matches</li>}
          {searchResults.map((r) => (
            <li key={`${r.folder}/${r.name}`}>
              <button className="search-result" onClick={() => onOpen(r.folder, r.name)}>
                <span className="search-result-name">{stripExt(r.name)}</span>
                <span className="search-result-folder muted small">
                  {r.folder || "Unfiled"}
                </span>
                {r.snippet && <span className="search-snippet">{r.snippet}</span>}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <>
      {/* Folders */}
      {creating?.kind === "folder" && (
        <div className="folder">
          <div className="folder-row">
            <div className="folder-toggle">
              <span className="caret">▾</span>
              <InlineInput
                placeholder="Folder name"
                onSubmit={(v) => submitFolder(v)}
                onCancel={() => setCreating(null)}
              />
            </div>
          </div>
        </div>
      )}
      {tree.folders.map((f) => (
        <div key={f.name} className="folder">
          <div
            className={`folder-row${dragOver === f.name ? " drag-over" : ""}`}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuKey(`folder:${f.name}`);
            }}
            {...dropProps(f.name)}
          >
            {renaming?.kind === "folder" && renaming.name === f.name ? (
              <div className="folder-toggle">
                <span className="caret">{collapsed[f.name] ? "▸" : "▾"}</span>
                <InlineInput
                  initial={f.name}
                  onSubmit={(v) => submitRenameFolder(f.name, v)}
                  onCancel={() => setRenaming(null)}
                />
              </div>
            ) : (
              <button className="folder-toggle" onClick={() => toggle(f.name)}>
                <span className="caret">{collapsed[f.name] ? "▸" : "▾"}</span>
                <span className="folder-name" title={f.name}>
                  {f.name}
                </span>
                <span className="muted small">{f.notes.length}</span>
              </button>
            )}
            <button
              className="icon-btn"
              title="Summarize folder"
              onClick={() => onSummarizeFolder(f.name)}
            >
              ✨
            </button>
            <button
              className="icon-btn"
              title="New note in folder"
              onClick={() => handleNewNote(f.name)}
            >
              ＋
            </button>
            {menuKey === `folder:${f.name}` && (
              <div className="popover" onMouseLeave={closeMenu}>
                <button
                  className="popover-item"
                  onClick={() => {
                    closeMenu();
                    onSummarizeFolder(f.name);
                  }}
                >
                  Summarize
                </button>
                <button
                  className="popover-item"
                  onClick={() => {
                    closeMenu();
                    handleNewNote(f.name);
                  }}
                >
                  New note
                </button>
                <button
                  className="popover-item"
                  onClick={() => handleRenameFolder(f.name)}
                >
                  Rename
                </button>
                <button
                  className="popover-item"
                  onClick={() => handleDeleteFolder(f.name, f.notes.length)}
                >
                  Delete
                </button>
              </div>
            )}
          </div>
          {!collapsed[f.name] && (
            <ul className="note-list indent">
              {creating?.kind === "note" && creating.folder === f.name && (
                <li>
                  <InlineInput
                    placeholder="Note name"
                    onSubmit={(v) => submitNote(f.name, v)}
                    onCancel={() => setCreating(null)}
                  />
                </li>
              )}
              {f.notes.length === 0 &&
                !(creating?.kind === "note" && creating.folder === f.name) && (
                  <li className="muted small empty">empty</li>
                )}
              {f.notes.map((n) => renderNote(f.name, n))}
            </ul>
          )}
        </div>
      ))}

      {/* Unfiled */}
      <div className={`unfiled${dragOver === "" ? " drag-over" : ""}`} {...dropProps("")}>
        <p className="sidebar-label">Unfiled</p>
        <ul className="note-list">
          {creating?.kind === "note" && creating.folder === "" && (
            <li>
              <InlineInput
                placeholder="Note name"
                onSubmit={(v) => submitNote("", v)}
                onCancel={() => setCreating(null)}
              />
            </li>
          )}
          {tree.unfiled.length === 0 &&
            !(creating?.kind === "note" && creating.folder === "") && (
              <li className="muted small empty">No unfiled notes</li>
            )}
          {tree.unfiled.map((n) => renderNote("", n))}
        </ul>
      </div>
        </>
      )}

      {/* Trash */}
      <button className="trash-row" onClick={onOpenTrash}>
        🗑 Recycle bin
        {tree.trashCount > 0 && <span className="badge">{tree.trashCount}</span>}
      </button>

      {user && (
        <div className="sidebar-user">
          <span className="sidebar-user-name" title={user.email}>
            {user.displayName || user.email}
          </span>
          <button className="icon-btn" onClick={onLogout} title="Sign out">
            ⎋
          </button>
        </div>
      )}

      {dialog && (
        <ConfirmDialog
          title={dialog.title}
          message={dialog.message}
          confirmLabel="Delete"
          danger
          onConfirm={dialog.onConfirm}
          onCancel={() => setDialog(null)}
        />
      )}
    </aside>
  );
}
