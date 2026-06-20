import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { sanitize, sanitizeReply, type SanitizeResponse } from "./api";

const REMARK_PLUGINS = [remarkGfm];

interface SanitizePanelProps {
  notes: string;
  onAccept: (markdown: string) => void;
  onClose: () => void;
}

type Phase = "loading" | "questions" | "preview" | "error";

/** Parse a "QUESTIONS:\n1. ...\n2. ..." block into individual question strings. */
function parseQuestions(result: string): string[] {
  return result
    .replace(/^\s*QUESTIONS:\s*/i, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter((l) => l.length > 0);
}

export default function SanitizePanel({ notes, onAccept, onClose }: SanitizePanelProps) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [sessionId, setSessionId] = useState("");
  const [questions, setQuestions] = useState<string[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [polished, setPolished] = useState("");
  const [error, setError] = useState("");

  function applyResponse(r: SanitizeResponse) {
    setSessionId(r.sessionId);
    if (r.needsClarification) {
      const qs = parseQuestions(r.result);
      setQuestions(qs);
      setAnswers(qs.map(() => ""));
      setPhase("questions");
    } else {
      setPolished(r.result);
      setPhase("preview");
    }
  }

  // Kick off the first sanitize pass when the panel opens.
  useEffect(() => {
    let cancelled = false;
    sanitize(notes)
      .then((r) => !cancelled && applyResponse(r))
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitAnswers() {
    setPhase("loading");
    const combined = questions
      .map((q, i) => `${i + 1}. ${q}\n   Answer: ${answers[i]?.trim() || "(no answer — keep as-is)"}`)
      .join("\n");
    try {
      const r = await sanitizeReply(sessionId, combined);
      applyResponse(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Sanitize notes</h2>
          <button className="icon-btn" onClick={onClose} title="Close">
            ✕
          </button>
        </div>

        {phase === "loading" && (
          <div className="modal-body center muted">
            <div className="spinner" />
            <p>Polishing with Claude (Opus)… this takes a few seconds.</p>
          </div>
        )}

        {phase === "error" && (
          <div className="modal-body">
            <p className="error">Something went wrong:</p>
            <pre className="error-detail">{error}</pre>
          </div>
        )}

        {phase === "questions" && (
          <div className="modal-body">
            <p className="muted">
              Claude needs a few clarifications to polish without changing your meaning:
            </p>
            <ol className="questions">
              {questions.map((q, i) => (
                <li key={i}>
                  <label>{q}</label>
                  <input
                    type="text"
                    value={answers[i] ?? ""}
                    placeholder="Your answer (leave blank to keep as-is)"
                    onChange={(e) => {
                      const next = [...answers];
                      next[i] = e.target.value;
                      setAnswers(next);
                    }}
                  />
                </li>
              ))}
            </ol>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button className="btn-primary" onClick={submitAnswers}>
                Continue
              </button>
            </div>
          </div>
        )}

        {phase === "preview" && (
          <div className="modal-body">
            <p className="muted">Polished result — review before accepting:</p>
            <div className="editor-rendered modal-rendered">
              <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{polished}</ReactMarkdown>
            </div>
            <div className="modal-actions">
              <button className="btn-secondary" onClick={onClose}>
                Discard
              </button>
              <button className="btn-primary" onClick={() => onAccept(polished)}>
                Accept &amp; replace notes
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
