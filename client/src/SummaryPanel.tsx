import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { refineSummary, summarizeFolder, type FolderSummaryResponse } from "./api";

const REMARK_PLUGINS = [remarkGfm];

interface SummaryPanelProps {
  folder: string;
  onSave: (markdown: string) => void;
  onClose: () => void;
}

type Phase = "loading" | "preview" | "error";

/**
 * Folder roll-up modal. Mirrors SanitizePanel's phases, but one-shot: it
 * summarizes the whole folder and lets you preview, regenerate, then save the
 * result as a note in that folder.
 */
export default function SummaryPanel({ folder, onSave, onClose }: SummaryPanelProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");
  // Resume handle for the steered-refine loop; updated after every response.
  const [sessionId, setSessionId] = useState("");
  const [instruction, setInstruction] = useState("");
  // Bumped per request; a response is applied only if it's still the latest one
  // (guards against close/regenerate landing a stale or post-unmount update).
  const reqId = useRef(0);

  const apply = (p: Promise<FolderSummaryResponse>) => {
    const id = ++reqId.current;
    setError("");
    setPhase("loading");
    p.then((r) => {
      if (id !== reqId.current) return;
      setSessionId(r.sessionId);
      setSummary(r.result);
      setPhase("preview");
    }).catch((e) => {
      if (id !== reqId.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    });
  };

  // Fresh summary from the notes (new session).
  const run = () => apply(summarizeFolder(folder));

  // Regenerate: with an instruction, steer the existing digest via its session;
  // empty instruction redoes the summary from scratch.
  const regenerate = () => {
    const instr = instruction.trim();
    apply(instr && sessionId ? refineSummary(sessionId, instr) : summarizeFolder(folder));
    setInstruction("");
  };

  useEffect(() => {
    run();
    return () => {
      reqId.current++; // invalidate any in-flight request on close/folder change
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Summarize {folder}</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {phase === "loading" && (
          <div className="modal-body center muted">
            <div className="spinner" />
            <p>Rolling up this week's notes with Claude (Opus)… this can take a bit.</p>
          </div>
        )}

        {phase === "error" && (
          <div className="modal-body">
            <p className="error">Something went wrong:</p>
            <pre className="error-detail">{error}</pre>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={onClose}>
                Close
              </button>
              <button className="btn-primary" onClick={run}>
                Try again
              </button>
            </div>
          </div>
        )}

        {phase === "preview" && (
          <div className="modal-body">
            <p className="muted">Weekly roll-up — review before saving:</p>
            <div className="editor-rendered modal-rendered">
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{summary}</ReactMarkdown>
            </div>
            <input
              className="summary-steer"
              type="text"
              value={instruction}
              placeholder="Steer the summary (optional) — e.g. “focus on decisions”, “make it shorter”"
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") regenerate();
              }}
            />
            <div className="modal-actions">
              <button className="btn-secondary" onClick={regenerate}>
                {instruction.trim() ? "Regenerate with steer" : "Regenerate"}
              </button>
              <button className="btn-secondary" onClick={onClose}>
                Close
              </button>
              <button className="btn-primary" onClick={() => onSave(summary)}>
                Save to folder
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
