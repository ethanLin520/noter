import { spawn } from "node:child_process";

/**
 * Thin wrapper around the Claude Code CLI in headless mode (`claude -p`).
 *
 * This is the ONLY place the app talks to an LLM. To swap to the Anthropic API
 * later, reimplement runClaude() against the SDK — callers won't change.
 *
 * NOTE: do NOT add `--bare`. On enterprise/managed accounts the credential is
 * supplied through Claude Code settings (apiKeyHelper), and `--bare` skips
 * settings loading, which breaks auth ("Not logged in"). Verified working
 * command: `claude -p --model <m> --tools "" --output-format json`.
 */

export type ClaudeModel = "haiku" | "sonnet" | "claude-opus-4-8" | string;

/** Reasoning budget passed to `claude -p --effort <level>`. */
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface RunClaudeOptions {
  /** The user-facing prompt. Passed as an argv element (no shell), so special
   *  characters and multi-KB notes are safe. */
  prompt: string;
  model: ClaudeModel;
  /** Reasoning budget (`--effort`). Omit to use the model's default. */
  effort?: ClaudeEffort;
  /** Guardrail appended to Claude Code's default system prompt. */
  appendSystemPrompt?: string;
  /** Resume a prior conversation to keep context (clarifying-question loop). */
  sessionId?: string;
  /** Hard timeout in ms before the subprocess is killed. */
  timeoutMs?: number;
  /**
   * Disable extended thinking (sets MAX_THINKING_TOKENS=0 in the child env).
   * Used for autocomplete: the model was emitting ~130 hidden thinking tokens
   * per keystroke-pause for a ~5-token answer, which dominated latency. Turning
   * it off cut per-call API time from ~1.5-4s down to ~0.9s with identical
   * results. Leave off for sanitize/summarize, which benefit from reasoning.
   */
  disableThinking?: boolean;
}

export interface RunClaudeResult {
  /** The model's text output. */
  result: string;
  /** Session id to resume this conversation on a later call. */
  sessionId: string;
  /** Total cost reported by the CLI (USD); 0 on subscription auth. */
  costUsd: number;
}

interface ClaudeJsonResponse {
  result: string;
  session_id: string;
  is_error: boolean;
  total_cost_usd?: number;
}

export class ClaudeError extends Error {}

const DEFAULT_TIMEOUT_MS = 120_000;

export function runClaude(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  const {
    prompt,
    model,
    effort,
    appendSystemPrompt,
    sessionId,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    disableThinking = false,
  } = opts;

  const args = ["-p", prompt, "--model", model, "--tools", "", "--output-format", "json"];
  if (effort) {
    args.push("--effort", effort);
  }
  if (appendSystemPrompt) {
    args.push("--append-system-prompt", appendSystemPrompt);
  }
  if (sessionId) {
    args.push("--resume", sessionId);
  }

  const env = disableThinking
    ? { ...process.env, MAX_THINKING_TOKENS: "0" }
    : process.env;

  return new Promise<RunClaudeResult>((resolve, reject) => {
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], env });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new ClaudeError(`claude -p timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ClaudeError(`failed to spawn claude: ${err.message}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        reject(
          new ClaudeError(
            `claude -p exited with code ${code}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }

      let parsed: ClaudeJsonResponse;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        reject(new ClaudeError(`could not parse claude output as JSON: ${stdout.slice(0, 500)}`));
        return;
      }

      if (parsed.is_error) {
        // e.g. "Not logged in · Please run /login"
        reject(new ClaudeError(`claude reported an error: ${parsed.result}`));
        return;
      }

      resolve({
        result: parsed.result,
        sessionId: parsed.session_id,
        costUsd: parsed.total_cost_usd ?? 0,
      });
    });
  });
}
