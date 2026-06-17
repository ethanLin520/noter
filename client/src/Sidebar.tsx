import { type RefObject, useState } from "react";
import {
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  moveNote,
  renameFolder,
  renameNote,
  type SearchResult,
  type Tree,
} from "./api";

interface OpenNote {
  folder: string;
  name: string;
}

interface SidebarProps {
  tree: Tree;
  current: OpenNote | null;
  onOpen: (folder: string, name: string) => void;
  onOpenTrash: () => void;
  /** Re-fetch the tree after a mutation. */
  reload: () => void;
  /** Notify App that the open note moved/renamed/was deleted. */
  onCurrentChanged: (next: OpenNote | null) => void;
  flash: (msg: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  searchResults: SearchResult[];
  searchInputRef: RefObject<HTMLInputElement>;
}

const stripExt = (name: string) => name.replace(/\.md$/i, "");

export default function Sidebar({
  tree,
  current,
  onOpen,
  onOpenTrash,
  reload,
  onCurrentChanged,
  flash,
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

  const handleNewNote = (folder: string) =>
    wrap(async () => {
      const raw = window.prompt(
        folder ? `New note in "${folder}"` : "New note name",
        "untitled",
      );
      if (raw == null) return;
      const { folder: f, name } = await createNote(folder, raw.trim() || "untitled");
      reload();
      onOpen(f, name);
    }, "Create failed");

  const handleNewFolder = () =>
    wrap(async () => {
      const raw = window.prompt("New folder name");
      if (raw == null) return;
      const trimmed = raw.trim();
      if (!trimmed) return;
      await createFolder(trimmed);
      reload();
    }, "Create folder failed");

  const handleRename = (folder: string, name: string) =>
    wrap(async () => {
      closeMenu();
      const raw = window.prompt("Rename note", stripExt(name));
      if (raw == null) return;
      const trimmed = raw.trim();
      if (!trimmed || trimmed === stripExt(name)) return;
      const { name: newName } = await renameNote(folder, name, trimmed);
      reload();
      if (isOpen(folder, name)) onCurrentChanged({ folder, name: newName });
      flash(`Renamed to ${stripExt(newName)}`);
    }, "Rename failed");

  const handleMove = (folder: string, name: string, toFolder: string) =>
    wrap(async () => {
      closeMenu();
      const { folder: f, name: n } = await moveNote(folder, name, toFolder);
      reload();
      if (isOpen(folder, name)) onCurrentChanged({ folder: f, name: n });
      flash(toFolder ? `Moved to ${toFolder}` : "Moved to Unfiled");
    }, "Move failed");

  const handleDelete = (folder: string, name: string) =>
    wrap(async () => {
      closeMenu();
      if (!window.confirm(`Move "${stripExt(name)}" to the recycle bin?`)) return;
      await deleteNote(folder, name);
      reload();
      if (isOpen(folder, name)) onCurrentChanged(null);
      flash("Moved to recycle bin");
    }, "Delete failed");

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

  const handleRenameFolder = (name: string) =>
    wrap(async () => {
      const raw = window.prompt("Rename folder", name);
      if (raw == null) return;
      const trimmed = raw.trim();
      if (!trimmed || trimmed === name) return;
      const { name: newName } = await renameFolder(name, trimmed);
      reload();
      if (current?.folder === name) onCurrentChanged({ folder: newName, name: current.name });
      flash(`Renamed folder to ${newName}`);
    }, "Rename folder failed");

  const handleDeleteFolder = (name: string, noteCount: number) =>
    wrap(async () => {
      const msg =
        noteCount > 0
          ? `Delete folder "${name}"? Its ${noteCount} note(s) will go to the recycle bin.`
          : `Delete empty folder "${name}"?`;
      if (!window.confirm(msg)) return;
      await deleteFolder(name);
      reload();
      if (current?.folder === name) onCurrentChanged(null);
      flash(`Deleted folder ${name}`);
    }, "Delete folder failed");

  const renderNote = (folder: string, name: string) => {
    const key = `${folder}/${name}`;
    const moveTargets = ["", ...folderNames].filter((f) => f !== folder);
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
      <h1 className="logo">Noter</h1>

      <div className="sidebar-actions">
        <button className="btn-secondary small" onClick={() => handleNewNote("")}>
          + Note
        </button>
        <button className="btn-secondary small" onClick={handleNewFolder}>
          + Folder
        </button>
      </div>

      <div className="search-box">
        <input
          ref={searchInputRef}
          className="search-input"
          type="search"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search notes…  (⌘K)"
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
      {tree.folders.map((f) => (
        <div key={f.name} className="folder">
          <div
            className={`folder-row${dragOver === f.name ? " drag-over" : ""}`}
            {...dropProps(f.name)}
          >
            <button className="folder-toggle" onClick={() => toggle(f.name)}>
              <span className="caret">{collapsed[f.name] ? "▸" : "▾"}</span>
              <span className="folder-name" title={f.name}>
                {f.name}
              </span>
              <span className="muted small">{f.notes.length}</span>
            </button>
            <button
              className="icon-btn"
              title="New note in folder"
              onClick={() => handleNewNote(f.name)}
            >
              ＋
            </button>
            <button
              className="icon-btn"
              title="Rename folder"
              onClick={() => handleRenameFolder(f.name)}
            >
              ✎
            </button>
            <button
              className="icon-btn"
              title="Delete folder"
              onClick={() => handleDeleteFolder(f.name, f.notes.length)}
            >
              🗑
            </button>
          </div>
          {!collapsed[f.name] && (
            <ul className="note-list indent">
              {f.notes.length === 0 && <li className="muted small empty">empty</li>}
              {f.notes.map((n) => renderNote(f.name, n))}
            </ul>
          )}
        </div>
      ))}

      {/* Unfiled */}
      <div className={`unfiled${dragOver === "" ? " drag-over" : ""}`} {...dropProps("")}>
        <p className="sidebar-label">Unfiled</p>
        <ul className="note-list">
          {tree.unfiled.length === 0 && (
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
    </aside>
  );
}
