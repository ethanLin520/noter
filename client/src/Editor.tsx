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

  const timerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Caret offset to apply once edit mode mounts (set when clicking the rendered view).
  const pendingCaretRef = useRef<number | null>(null);

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
      try {
        const text = await autocomplete(context, currentLine, controller.signal);
        // Only show if it's a real change and the line is unchanged since the request.
        if (text && text.trim() !== currentLine.trim()) {
          setSuggestion({ text: text.trim(), lineStart, lineEnd, original: currentLine });
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
  }, [cancelPending]);

  const acceptSuggestion = useCallback(() => {
    if (!suggestion) return;
    const { text, lineStart, lineEnd, original } = suggestion;
    // Bail if the underlying line changed since the suggestion was made.
    if (value.slice(lineStart, lineEnd) !== original) {
      setSuggestion(null);
      return;
    }
    const next = value.slice(0, lineStart) + text + value.slice(lineEnd);
    onChange(next);
    setSuggestion(null);
    // Restore caret to the end of the replaced line.
    const newCaret = lineStart + text.length;
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(newCaret, newCaret);
      }
    });
  }, [suggestion, value, onChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (suggestion && e.key === "Tab") {
        e.preventDefault();
        acceptSuggestion();
        return;
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
    [suggestion, loading, acceptSuggestion, cancelPending, onModeChange],
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value);
    setSuggestion(null);
    schedule();
  };

  // Clean up timers/aborts on unmount.
  useEffect(() => cancelPending, [cancelPending]);

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
      <div className="suggestion-bar" aria-live="polite">
        {loading && !suggestion && <span className="suggestion-loading">thinking…</span>}
        {suggestion && (
          <button className="suggestion" onClick={acceptSuggestion} title="Accept (Tab)">
            <span className="suggestion-arrow">→</span>
            <span className="suggestion-text">{suggestion.text}</span>
            <span className="suggestion-hint">Tab</span>
          </button>
        )}
      </div>
    </div>
  );
}
