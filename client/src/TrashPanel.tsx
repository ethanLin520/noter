import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "./Dialog";
import { emptyTrash, getTrash, purgeTrash, restoreTrash, type TrashItem } from "./api";

interface TrashPanelProps {
  /** Called after any change so App can refresh the tree. */
  onChanged: () => void;
  onClose: () => void;
}

const stripExt = (name: string) => name.replace(/\.md$/i, "");

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

export default function TrashPanel({ onChanged, onClose }: TrashPanelProps) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // Active purge confirmation: "all" for empty-bin, or a single item.
  const [confirm, setConfirm] = useState<"all" | TrashItem | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    getTrash()
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      refresh();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Recycle bin</h2>
          <div className="toolbar-actions">
            {items.length > 0 && (
              <button className="btn-secondary small" onClick={() => setConfirm("all")}>
                Empty bin
              </button>
            )}
            <button className="icon-btn" onClick={onClose} title="Close">
              ✕
            </button>
          </div>
        </div>
        <div className="modal-body">
          {error && <p className="error">{error}</p>}
          {loading && <div className="spinner" />}
          {!loading && items.length === 0 && (
            <p className="muted">The recycle bin is empty.</p>
          )}
          <ul className="trash-list">
            {items.map((it) => (
              <li key={it.id} className="trash-item">
                <div className="trash-meta">
                  <span className="trash-name">{stripExt(it.originalName)}</span>
                  <span className="muted small">
                    {it.originalFolder || "Unfiled"} · {relativeTime(it.deletedAt)}
                  </span>
                </div>
                <div className="trash-actions">
                  <button className="btn-secondary small" onClick={() => run(() => restoreTrash(it.id))}>
                    Restore
                  </button>
                  <button
                    className="btn-secondary small danger"
                    onClick={() => setConfirm(it)}
                  >
                    Delete forever
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm === "all" ? "Empty recycle bin" : "Delete forever"}
          message={
            confirm === "all"
              ? "Permanently delete all items in the recycle bin? This cannot be undone."
              : `Permanently delete "${stripExt(confirm.originalName)}"? This cannot be undone.`
          }
          confirmLabel="Delete forever"
          danger
          onConfirm={() => {
            const target = confirm;
            setConfirm(null);
            run(() => (target === "all" ? emptyTrash() : purgeTrash(target.id)));
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
