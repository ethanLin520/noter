import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { autocomplete } from "./api";

export type EditorMode = "edit" | "rendered";

interface Suggestion {
  /** The cleaned-up line the model suggests. */
  text: string;
  /** Offsets in `value` of the line this suggestion replaces, captured at request time. */
  lineStart: number;
  lineEnd: number;
  /** The original line text, so we can bail if the user edited it since. */
  original: string;
}

interface EditorProps {
  value: string;
  onChange: (next: string) => void;
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
}

const DEBOUNCE_MS = 900;

/** Platform-aware labels for the post-accept undo/redo hint. */
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const UNDO_LABEL = IS_MAC ? "⌘Z to undo" : "Ctrl+Z to undo";
const REDO_LABEL = IS_MAC ? "⇧⌘Z to redo" : "Ctrl+Shift+Z to redo";

/** Snapshot of one accepted suggestion, enough to undo and redo it. */
interface AcceptSnapshot {
  prevValue: string;
  prevCaret: number;
  nextValue: string;
  nextCaret: number;
  /** Card position at accept time, reused to anchor the undo/redo hint. */
  pos: { top: number; left: number; above: boolean } | null;
}

type Hint = { top: number; left: number; above: boolean; label: string; action: "undo" | "redo" };

/**
 * Rehype plugin: stamp each rendered element with `data-pos` = its source offset
 * (from the mdast/hast `position`), so a click in the rendered view can be mapped
 * back to a character offset in the raw Markdown. Recurses manually to avoid a dep.
 */
function rehypeSourceOffset() {
  return (tree: any) => {
    const walk = (n: any) => {
      if (n.type === "element" && n.position?.start?.offset != null) {
        n.properties = n.properties || {};
        n.properties.dataPos = n.position.start.offset;
      }
      n.children?.forEach(walk);
    };
    walk(tree);
  };
}
const REHYPE_PLUGINS = [rehypeSourceOffset];
const REMARK_PLUGINS = [remarkGfm];

/** The clicked text node + intra-node offset at viewport coords, cross-browser. */
function caretFromPoint(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as any;
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos?.offsetNode) return { node: pos.offsetNode, offset: pos.offset };
  }
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) return { node: r.startContainer, offset: r.startOffset };
  }
  return null;
}

/**
 * Map a click in the rendered view to a caret offset in the raw Markdown `value`.
 * Anchors the search at the clicked block's `data-pos` so repeated text resolves to
 * the clicked instance and leading syntax (`## `, `- `, …) is skipped. Returns null
 * if no text node resolves under the cursor (e.g. empty/gutter area).
 */
function sourceOffsetFromClick(
  value: string,
  container: HTMLElement,
  x: number,
  y: number,
): number | null {
  const caret = caretFromPoint(x, y);
  if (!caret) return null;
  let el: HTMLElement | null =
    caret.node.nodeType === Node.TEXT_NODE
      ? caret.node.parentElement
      : (caret.node as HTMLElement);
  while (el && el.dataset.pos == null && el !== container) el = el.parentElement;
  const blockStart = el && el.dataset.pos != null ? Number(el.dataset.pos) : 0;
  if (caret.node.nodeType === Node.TEXT_NODE) {
    const text = caret.node.textContent ?? "";
    const idx = value.indexOf(text, blockStart);
    if (idx >= 0) return idx + Math.min(caret.offset, text.length);
  }
  return blockStart;
}

/**
 * Pixel coordinates of a character offset inside a textarea, via the standard
 * hidden "mirror div" technique: a styled clone of the textarea is laid out with
 * the text up to `pos`, and a marker span's position is read back. Returns
 * coordinates relative to the textarea's own content box (pre-scroll).
 */
function caretCoords(ta: HTMLTextAreaElement, pos: number): { top: number; left: number; lineHeight: number } {
  const div = document.createElement("div");
  const style = getComputedStyle(ta);
  const props = [
    "boxSizing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing",
    "lineHeight", "textTransform", "wordSpacing", "tabSize",
  ] as const;
  for (const p of props) div.style[p as any] = style[p as any];
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  div.style.overflow = "hidden";
  div.style.width = `${ta.clientWidth}px`;

  div.textContent = ta.value.slice(0, pos);
  const span = document.createElement("span");
  // Non-empty so it has a layout box even at end-of-text.
  span.textContent = ta.value.slice(pos) || ".";
  div.appendChild(span);

  document.body.appendChild(div);
  const top = span.offsetTop + parseFloat(style.borderTopWidth);
  const left = span.offsetLeft + parseFloat(style.borderLeftWidth);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
  document.body.removeChild(div);
  return { top, left, lineHeight };
}

/** Find the line containing the caret: its bounds, text, and preceding context. */
function lineAtCaret(value: string, caret: number) {
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  const nlAfter = value.indexOf("\n", caret);
  const lineEnd = nlAfter === -1 ? value.length : nlAfter;
  return {
    lineStart,
    lineEnd,
    currentLine: value.slice(lineStart, lineEnd),
    context: value.slice(0, lineStart),
  };
}

export default function Editor({ value, onChange, mode, onModeChange }: EditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [loading, setLoading] = useState(false);
  // Pixel position (relative to the .editor box) of the floating suggestion card.
  const [pop, setPop] = useState<{ top: number; left: number; above: boolean } | null>(null);
  // Transient undo/redo hint shown at the corrected line for a moment after accepting.
  const [undoHint, setUndoHint] = useState<Hint | null>(null);
  const undoHintTimer = useRef<number | null>(null);

  const timerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Caret offset to apply once edit mode mounts (set when clicking the rendered view).
  const pendingCaretRef = useRef<number | null>(null);
  // Snapshots for undo (Cmd/Ctrl+Z) and redo (Cmd/Ctrl+Shift+Z) of the most
  // recently accepted suggestion. Both are cleared on any manual edit, so the
  // textarea's native undo/redo takes over once the user types.
  const lastAcceptRef = useRef<AcceptSnapshot | null>(null);
  const redoRef = useRef<AcceptSnapshot | null>(null);

  const cancelPending = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  // Position the floating card just below the caret's line (flipping above when
  // it would overflow the editor's bottom). Anchored at the line start so it
  // doesn't jitter horizontally as the corrected line differs from what's typed.
  const ESTIMATED_CARD_H = 48;
  const computePop = useCallback(() => {
    const ta = taRef.current;
    if (!ta) {
      setPop(null);
      return;
    }
    const { lineStart } = lineAtCaret(ta.value, ta.selectionStart);
    const caret = caretCoords(ta, lineStart);
    const lineTop = ta.offsetTop + caret.top - ta.scrollTop;
    const editorH = (ta.offsetParent as HTMLElement | null)?.clientHeight ?? ta.clientHeight;
    const belowTop = lineTop + caret.lineHeight + 4;
    const above = belowTop + ESTIMATED_CARD_H > editorH && lineTop > ESTIMATED_CARD_H;
    const top = above ? lineTop - 4 : belowTop;
    const minLeft = ta.offsetLeft;
    const maxLeft = Math.max(minLeft, ta.offsetLeft + ta.clientWidth - 80);
    const left = Math.max(minLeft, Math.min(ta.offsetLeft + caret.left, maxLeft));
    setPop({ top, left, above });
  }, []);

  const clearUndoHint = useCallback(() => {
    if (undoHintTimer.current !== null) {
      clearTimeout(undoHintTimer.current);
      undoHintTimer.current = null;
    }
    setUndoHint(null);
  }, []);

  // Briefly float an undo/redo hint at the accepted line, then fade it out.
  const showHint = useCallback(
    (pos: AcceptSnapshot["pos"], label: string, action: Hint["action"]) => {
      if (undoHintTimer.current !== null) clearTimeout(undoHintTimer.current);
      if (!pos) {
        setUndoHint(null);
        return;
      }
      setUndoHint({ ...pos, label, action });
      undoHintTimer.current = window.setTimeout(() => setUndoHint(null), 2600);
    },
    [],
  );

  // Schedule an autocomplete request for the current line after a typing pause.
  const schedule = useCallback(() => {
    cancelPending();
    if (!taRef.current) return;

    timerRef.current = window.setTimeout(async () => {
      const ta = taRef.current;
      if (!ta) return;
      // Read live value/caret here so the request reflects the latest keystrokes.
      const { lineStart, lineEnd, currentLine, context } = lineAtCaret(ta.value, ta.selectionStart);
      if (currentLine.trim().length === 0) {
        setSuggestion(null);
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      computePop();
      try {
        const text = await autocomplete(context, currentLine, controller.signal);
        // Only show if it's a real change and the line is unchanged since the request.
        if (text && text.trim() !== currentLine.trim()) {
          setSuggestion({ text: text.trim(), lineStart, lineEnd, original: currentLine });
          computePop();
        } else {
          setSuggestion(null);
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          // Network/CLI error — fail silently for autocomplete; sanitize surfaces errors.
          setSuggestion(null);
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setLoading(false);
      }
    }, DEBOUNCE_MS);
  }, [cancelPending, computePop]);

  const acceptSuggestion = useCallback(() => {
    if (!suggestion) return;
    const { text, lineStart, lineEnd, original } = suggestion;
    // Bail if the underlying line changed since the suggestion was made.
    if (value.slice(lineStart, lineEnd) !== original) {
      setSuggestion(null);
      return;
    }
    const next = value.slice(0, lineStart) + text + value.slice(lineEnd);
    const newCaret = lineStart + text.length;
    // Remember enough to undo (and later redo) just this accept. React value
    // changes don't populate the textarea's native undo stack, so we track it.
    lastAcceptRef.current = {
      prevValue: value,
      prevCaret: lineStart + original.length,
      nextValue: next,
      nextCaret: newCaret,
      pos: pop,
    };
    redoRef.current = null;
    onChange(next);
    setSuggestion(null);
    showHint(pop, UNDO_LABEL, "undo");
    // Restore caret to the end of the replaced line.
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(newCaret, newCaret);
      }
    });
  }, [suggestion, value, onChange, pop, showHint]);

  // Restore one of the snapshot's states (undo → prev, redo → next), moving the
  // snapshot to the opposite ref so the inverse action is then available.
  const restoreSnapshot = useCallback(
    (snap: AcceptSnapshot, to: "prev" | "next") => {
      cancelPending();
      setSuggestion(null);
      const targetValue = to === "prev" ? snap.prevValue : snap.nextValue;
      const targetCaret = to === "prev" ? snap.prevCaret : snap.nextCaret;
      onChange(targetValue);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.setSelectionRange(targetCaret, targetCaret);
        }
      });
    },
    [cancelPending, onChange],
  );

  const undoAccept = useCallback(() => {
    const snap = lastAcceptRef.current;
    if (!snap) return false;
    lastAcceptRef.current = null;
    redoRef.current = snap;
    restoreSnapshot(snap, "prev");
    showHint(snap.pos, REDO_LABEL, "redo");
    return true;
  }, [restoreSnapshot, showHint]);

  const redoAccept = useCallback(() => {
    const snap = redoRef.current;
    if (!snap) return false;
    redoRef.current = null;
    lastAcceptRef.current = snap;
    restoreSnapshot(snap, "next");
    showHint(snap.pos, UNDO_LABEL, "undo");
    return true;
  }, [restoreSnapshot, showHint]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (suggestion && e.key === "Tab") {
        e.preventDefault();
        acceptSuggestion();
        return;
      }
      // Cmd/Ctrl+(Shift+)Z right after accepting undoes/redoes that accept (React
      // value changes don't populate the textarea's native undo stack).
      if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
        if (e.shiftKey ? redoAccept() : undoAccept()) {
          e.preventDefault();
          return;
        }
      }
      if (e.key === "Escape") {
        // First Esc dismisses an active/loading suggestion; with none, return to preview.
        if (suggestion || loading) {
          cancelPending();
          setSuggestion(null);
        } else {
          onModeChange("rendered");
        }
      }
    },
    [suggestion, loading, acceptSuggestion, undoAccept, redoAccept, cancelPending, onModeChange],
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // A manual edit invalidates the accept undo/redo snapshots; native undo resumes.
    lastAcceptRef.current = null;
    redoRef.current = null;
    clearUndoHint();
    onChange(e.target.value);
    setSuggestion(null);
    schedule();
  };

  // Clean up timers/aborts on unmount.
  useEffect(() => {
    return () => {
      cancelPending();
      if (undoHintTimer.current !== null) clearTimeout(undoHintTimer.current);
    };
  }, [cancelPending]);

  // Keep the floating card anchored to its line while shown; drop it otherwise.
  useEffect(() => {
    if (!suggestion && !loading) {
      setPop(null);
      return;
    }
    const ta = taRef.current;
    if (!ta) return;
    const recompute = () => computePop();
    ta.addEventListener("scroll", recompute);
    window.addEventListener("resize", recompute);
    return () => {
      ta.removeEventListener("scroll", recompute);
      window.removeEventListener("resize", recompute);
    };
  }, [suggestion, loading, computePop]);

  // Focus the textarea when entering edit mode, and place the caret where the
  // rendered view was clicked (if any).
  useEffect(() => {
    if (mode !== "edit") return;
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    const off = pendingCaretRef.current;
    if (off != null) {
      const c = Math.max(0, Math.min(off, ta.value.length));
      ta.setSelectionRange(c, c);
    }
    pendingCaretRef.current = null;
  }, [mode]);

  if (mode === "rendered") {
    const onRenderedClick = (e: React.MouseEvent<HTMLDivElement>) => {
      pendingCaretRef.current = sourceOffsetFromClick(
        value,
        e.currentTarget,
        e.clientX,
        e.clientY,
      );
      onModeChange("edit");
    };
    return (
      <div
        className="editor editor-rendered"
        onClick={onRenderedClick}
        title="Click to edit"
      >
        {value.trim().length === 0 ? (
          <p className="editor-rendered-empty">Nothing to preview yet</p>
        ) : (
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS}>
            {value}
          </ReactMarkdown>
        )}
      </div>
    );
  }

  return (
    <div className="editor">
      <textarea
        ref={taRef}
        className="editor-textarea"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Type your meeting notes — shorthand and typos are fine. Pause to get a cleaned-up suggestion, press Tab to accept."
        spellCheck={false}
      />
      {pop && (loading || suggestion) && (
        <div
          className={`suggestion-pop${pop.above ? " is-above" : ""}`}
          style={{ top: pop.top, left: pop.left }}
          aria-live="polite"
        >
          {loading && !suggestion && (
            <span className="suggestion-loading">thinking…</span>
          )}
          {suggestion && (
            <button className="suggestion" onClick={acceptSuggestion} title="Accept (Tab)">
              <span className="suggestion-arrow">→</span>
              <span className="suggestion-text">{suggestion.text}</span>
              <span className="suggestion-hint">Tab</span>
            </button>
          )}
        </div>
      )}
      {undoHint && !suggestion && !loading && (
        <div
          className={`suggestion-pop suggestion-undo${undoHint.above ? " is-above" : ""}`}
          style={{ top: undoHint.top, left: undoHint.left }}
          aria-live="polite"
        >
          <button
            className="suggestion-undo-btn"
            onClick={undoHint.action === "undo" ? undoAccept : redoAccept}
            title={undoHint.label}
          >
            <span className="suggestion-arrow">↩</span>
            <span>{undoHint.label}</span>
          </button>
        </div>
      )}
    </div>
  );
}
