import express from "express";
import cors from "cors";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runClaude, ClaudeError } from "./claude.js";
import {
  AUTOCOMPLETE_SYSTEM,
  SANITIZE_SYSTEM,
  SUMMARIZE_SYSTEM,
  buildAutocompletePrompt,
  buildSanitizePrompt,
  buildSanitizeReplyPrompt,
  buildFolderSummaryPrompt,
  buildSummaryRefinePrompt,
} from "./prompts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = path.resolve(__dirname, "../../notes");
const TRASH_DIR = path.join(NOTES_DIR, ".trash");
const TRASH_MANIFEST = path.join(TRASH_DIR, "trash.json");
const PORT = Number(process.env.PORT ?? 23456);

const AUTOCOMPLETE_MODEL = "haiku";
const SANITIZE_MODEL = "claude-opus-4-8";
// Summarizing a whole folder feeds many notes at once, so allow a longer run.
const SUMMARIZE_TIMEOUT_MS = 300_000;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/** Wrap an async route so thrown errors become clean JSON 500s. */
function handler(fn: (req: express.Request, res: express.Response) => Promise<void>) {
  return (req: express.Request, res: express.Response) => {
    fn(req, res).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof ClaudeError ? 502 : 500;
      console.error(`[error] ${req.method} ${req.path}: ${message}`);
      res.status(status).json({ error: message });
    });
  };
}

/** Returns true if the sanitize output is a clarifying-questions response. */
function isQuestions(result: string): boolean {
  return /^\s*QUESTIONS:/i.test(result);
}

/** Turn an arbitrary title into a safe `.md` filename (no path traversal). */
function safeFileName(name: string): string {
  const base = path.basename(name.trim() || "untitled");
  const cleaned = base.replace(/[^a-zA-Z0-9 _.-]/g, "").replace(/\s+/g, "-");
  const stem = cleaned.replace(/\.md$/i, "") || "untitled";
  return `${stem}.md`;
}

/** The reserved `.md` filename used for a folder's roll-up summary. */
function summaryFileName(folderName: string): string {
  return safeFileName(`${folderName} Summary`);
}

/** Turn an arbitrary folder label into a safe single-segment folder name. */
function safeFolderName(name: string): string {
  const base = path.basename(name.trim());
  const cleaned = base.replace(/[^a-zA-Z0-9 _.-]/g, "").replace(/\s+/g, "-");
  // Reject leading-dot names (e.g. ".trash") and empties.
  return /^\.+/.test(cleaned) ? "" : cleaned;
}

/**
 * Join segments under NOTES_DIR and guarantee the result stays inside it.
 * Throws on any attempted path traversal.
 */
function resolveInNotes(...segments: string[]): string {
  const target = path.resolve(NOTES_DIR, ...segments);
  const root = path.resolve(NOTES_DIR);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("path escapes notes directory");
  }
  return target;
}

interface TrashEntry {
  id: string;
  originalName: string; // e.g. "2026-06-10-meeting.md"
  originalFolder: string; // "" = unfiled
  deletedAt: string; // ISO timestamp
}

async function readManifest(): Promise<TrashEntry[]> {
  try {
    const raw = await fs.readFile(TRASH_MANIFEST, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TrashEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeManifest(entries: TrashEntry[]): Promise<void> {
  await fs.mkdir(TRASH_DIR, { recursive: true });
  await fs.writeFile(TRASH_MANIFEST, JSON.stringify(entries, null, 2), "utf8");
}

/** Short, collision-resistant id for trashed files. */
function makeId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** Pick a non-colliding `.md` name in `dir` for `desired` (adds -1, -2, ...). */
async function uniqueName(dir: string, desired: string): Promise<string> {
  const stem = desired.replace(/\.md$/i, "");
  let candidate = `${stem}.md`;
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await fs.access(path.join(dir, candidate));
      candidate = `${stem}-${n++}.md`;
    } catch {
      return candidate;
    }
  }
}

// --- Health: confirms headless claude -p auth works -------------------------
app.get(
  "/api/health",
  handler(async (_req, res) => {
    const r = await runClaude({
      prompt: "Reply with exactly: ok",
      model: AUTOCOMPLETE_MODEL,
      timeoutMs: 30_000,
    });
    res.json({ ok: r.result.trim().toLowerCase().includes("ok"), result: r.result });
  }),
);

// --- Autocomplete: fast, minimal correction of the current line -------------
app.post(
  "/api/autocomplete",
  handler(async (req, res) => {
    const { context = "", currentLine = "" } = req.body ?? {};
    if (typeof currentLine !== "string" || currentLine.trim().length === 0) {
      res.json({ suggestion: "" });
      return;
    }
    const r = await runClaude({
      prompt: buildAutocompletePrompt(String(context), currentLine),
      model: AUTOCOMPLETE_MODEL,
      appendSystemPrompt: AUTOCOMPLETE_SYSTEM,
      timeoutMs: 30_000,
      disableThinking: true,
    });
    // The model emits NO_SUGGESTION when the line is gibberish or can't be
    // confidently improved; map that to an empty suggestion (client shows none).
    const out = r.result.trim();
    res.json({ suggestion: out === "NO_SUGGESTION" ? "" : out });
  }),
);

// --- Sanitize: polish whole note, may ask clarifying questions --------------
app.post(
  "/api/sanitize",
  handler(async (req, res) => {
    const { notes = "" } = req.body ?? {};
    if (typeof notes !== "string" || notes.trim().length === 0) {
      res.status(400).json({ error: "notes is required" });
      return;
    }
    const r = await runClaude({
      prompt: buildSanitizePrompt(notes),
      model: SANITIZE_MODEL,
      appendSystemPrompt: SANITIZE_SYSTEM,
    });
    res.json({
      result: r.result,
      sessionId: r.sessionId,
      needsClarification: isQuestions(r.result),
    });
  }),
);

// --- Sanitize reply: feed answers back, continue the clarifying loop --------
app.post(
  "/api/sanitize/reply",
  handler(async (req, res) => {
    const { sessionId, answers = "" } = req.body ?? {};
    if (typeof sessionId !== "string" || !sessionId) {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }
    const r = await runClaude({
      prompt: buildSanitizeReplyPrompt(String(answers)),
      model: SANITIZE_MODEL,
      appendSystemPrompt: SANITIZE_SYSTEM,
      sessionId,
    });
    res.json({
      result: r.result,
      sessionId: r.sessionId,
      needsClarification: isQuestions(r.result),
    });
  }),
);

// --- Folder summarize: roll a week's notes into one digest (Opus) -----------
app.post(
  "/api/folder/summarize",
  handler(async (req, res) => {
    const { folder = "" } = req.body ?? {};
    const folderName = folder ? safeFolderName(String(folder)) : "";
    if (!folderName) {
      res.status(400).json({ error: "invalid folder name" });
      return;
    }
    const dir = resolveInNotes(folderName);
    // Skip the folder's own summary note so it never feeds its own output back in.
    const summaryFile = summaryFileName(folderName).toLowerCase();
    const names = (await listMd(dir, "name")).filter((n) => n.toLowerCase() !== summaryFile);
    if (names.length === 0) {
      res.status(400).json({ error: "no notes to summarize in this folder" });
      return;
    }
    const notes = await Promise.all(
      names.map(async (name) => ({
        name: name.replace(/\.md$/i, ""),
        content: await fs.readFile(resolveInNotes(folderName, name), "utf8"),
      })),
    );
    const r = await runClaude({
      prompt: buildFolderSummaryPrompt(notes),
      model: SANITIZE_MODEL,
      appendSystemPrompt: SUMMARIZE_SYSTEM,
      timeoutMs: SUMMARIZE_TIMEOUT_MS,
    });
    res.json({ result: r.result, sessionId: r.sessionId });
  }),
);

// --- Folder summarize reply: steer the digest within the same session -------
app.post(
  "/api/folder/summarize/reply",
  handler(async (req, res) => {
    const { sessionId, instruction = "" } = req.body ?? {};
    if (typeof sessionId !== "string" || !sessionId) {
      res.status(400).json({ error: "sessionId is required" });
      return;
    }
    if (typeof instruction !== "string" || !instruction.trim()) {
      res.status(400).json({ error: "instruction is required" });
      return;
    }
    const r = await runClaude({
      prompt: buildSummaryRefinePrompt(instruction),
      model: SANITIZE_MODEL,
      appendSystemPrompt: SUMMARIZE_SYSTEM,
      sessionId,
      timeoutMs: SUMMARIZE_TIMEOUT_MS,
    });
    res.json({ result: r.result, sessionId: r.sessionId });
  }),
);

// --- Notes & folders: file management ---------------------------------------

type SortMode = "edited-desc" | "edited-asc" | "name";

function parseSort(raw: unknown): SortMode {
  return raw === "edited-asc" || raw === "name" ? raw : "edited-desc";
}

/** Sort `.md` filenames in `dir` by the chosen mode. "edited" uses file mtime. */
async function sortNotes(dir: string, names: string[], sort: SortMode): Promise<string[]> {
  if (sort === "name") return [...names].sort((a, b) => a.localeCompare(b));
  const withTime = await Promise.all(
    names.map(async (name) => {
      let t = 0;
      try {
        const s = await fs.stat(path.join(dir, name));
        t = s.mtimeMs;
      } catch {
        /* missing/unreadable file sorts as oldest */
      }
      return { name, t };
    }),
  );
  withTime.sort((a, b) => (sort === "edited-asc" ? a.t - b.t : b.t - a.t));
  return withTime.map((x) => x.name);
}

/** List `.md` files in a directory, sorted; tolerates a missing dir. */
async function listMd(dir: string, sort: SortMode): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    const names = entries.filter((f) => f.toLowerCase().endsWith(".md"));
    return sortNotes(dir, names, sort);
  } catch {
    return [];
  }
}

/** Latest edit time (mtime, ms) among `names` in `dir`; 0 if none/unreadable. */
async function latestMtime(dir: string, names: string[]): Promise<number> {
  let latest = 0;
  await Promise.all(
    names.map(async (name) => {
      try {
        const s = await fs.stat(path.join(dir, name));
        if (s.mtimeMs > latest) latest = s.mtimeMs;
      } catch {
        /* missing/unreadable file is ignored */
      }
    }),
  );
  return latest;
}

// Full sidebar state in one call.
app.get(
  "/api/tree",
  handler(async (req, res) => {
    const sort = parseSort(req.query.sort);
    await fs.mkdir(NOTES_DIR, { recursive: true });
    const entries = await fs.readdir(NOTES_DIR, { withFileTypes: true });

    const unfiledNames = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => e.name);
    const unfiled = await sortNotes(NOTES_DIR, unfiledNames, sort);

    const folderNames = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);

    const folderList = await Promise.all(
      folderNames.map(async (name) => {
        const dir = path.join(NOTES_DIR, name);
        const notes = await listMd(dir, sort);
        return { name, notes, latest: await latestMtime(dir, notes) };
      }),
    );

    // Folder order follows the active sort: by name alphabetically, otherwise
    // by the latest edit time of the folder's notes (empty folders sort oldest).
    if (sort === "name") {
      folderList.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      folderList.sort((a, b) =>
        sort === "edited-asc" ? a.latest - b.latest : b.latest - a.latest,
      );
    }

    const folders = folderList.map(({ name, notes }) => ({ name, notes }));

    const trash = await readManifest();
    res.json({ unfiled, folders, trashCount: trash.length });
  }),
);

// Full-text + filename search across all notes (skips the recycle bin).
app.get(
  "/api/search",
  handler(async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) {
      res.json({ results: [] });
      return;
    }
    const needle = q.toLowerCase();

    await fs.mkdir(NOTES_DIR, { recursive: true });
    const entries = await fs.readdir(NOTES_DIR, { withFileTypes: true });
    const folderNames = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);

    // [folder, name] pairs for every note: unfiled first, then each folder.
    const files: [string, string][] = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e): [string, string] => ["", e.name]);
    for (const folder of folderNames) {
      for (const name of await listMd(path.join(NOTES_DIR, folder), "name")) {
        files.push([folder, name]);
      }
    }

    const SNIPPET_PAD = 40;
    const MAX_RESULTS = 50;
    type Hit = { folder: string; name: string; snippet: string; isBody: boolean };

    // Read all candidate files in parallel; Promise.all preserves `files` order.
    const matches = await Promise.all(
      files.map(async ([folder, name]): Promise<Hit | null> => {
        let content = "";
        try {
          content = await fs.readFile(resolveInNotes(folder, name), "utf8");
        } catch {
          return null;
        }
        const idx = content.toLowerCase().indexOf(needle);
        const nameMatch = name.toLowerCase().includes(needle);
        if (idx === -1 && !nameMatch) return null;

        let snippet: string;
        if (idx !== -1) {
          const start = Math.max(0, idx - SNIPPET_PAD);
          const end = Math.min(content.length, idx + needle.length + SNIPPET_PAD);
          snippet =
            (start > 0 ? "…" : "") +
            content.slice(start, end).replace(/\s+/g, " ").trim() +
            (end < content.length ? "…" : "");
        } else {
          // Filename-only match: show the first non-empty line as context.
          snippet = (content.split("\n").find((l) => l.trim()) ?? "").trim();
        }
        return { folder, name, snippet, isBody: idx !== -1 };
      }),
    );

    const hits = matches.filter((m): m is Hit => m !== null);
    const strip = ({ folder, name, snippet }: Hit) => ({ folder, name, snippet });
    // Filename matches first, then body matches.
    const ordered = [...hits.filter((m) => !m.isBody), ...hits.filter((m) => m.isBody)];
    res.json({ results: ordered.slice(0, MAX_RESULTS).map(strip) });
  }),
);

// Save a note in an optional folder. `createNew` picks a non-colliding name so
// a brand-new note can never clobber an existing file; otherwise the named file
// is overwritten in place (the normal autosave-the-open-note case).
app.post(
  "/api/save",
  handler(async (req, res) => {
    const { folder = "", name = "untitled", markdown = "", createNew = false } = req.body ?? {};
    if (typeof markdown !== "string") {
      res.status(400).json({ error: "markdown is required" });
      return;
    }
    const folderName = folder ? safeFolderName(String(folder)) : "";
    if (folder && !folderName) {
      res.status(400).json({ error: "invalid folder name" });
      return;
    }
    const dir = folderName ? resolveInNotes(folderName) : NOTES_DIR;
    await fs.mkdir(dir, { recursive: true });
    const fileName = createNew
      ? await uniqueName(dir, safeFileName(String(name)))
      : safeFileName(String(name));
    await fs.writeFile(resolveInNotes(folderName, fileName), markdown, "utf8");
    res.json({ ok: true, folder: folderName, name: fileName });
  }),
);

// Load a note via query params (folder may contain nothing for unfiled).
app.get(
  "/api/note",
  handler(async (req, res) => {
    const folderName = req.query.folder ? safeFolderName(String(req.query.folder)) : "";
    const fileName = safeFileName(String(req.query.name ?? ""));
    try {
      const fullPath = resolveInNotes(folderName, fileName);
      const [markdown, stat] = await Promise.all([
        fs.readFile(fullPath, "utf8"),
        fs.stat(fullPath),
      ]);
      res.json({ folder: folderName, name: fileName, markdown, mtime: stat.mtime.toISOString() });
    } catch {
      res.status(404).json({ error: "note not found" });
    }
  }),
);

// Create an empty note (errors if one already exists).
app.post(
  "/api/note/create",
  handler(async (req, res) => {
    const { folder = "", name = "untitled" } = req.body ?? {};
    const folderName = folder ? safeFolderName(String(folder)) : "";
    if (folder && !folderName) {
      res.status(400).json({ error: "invalid folder name" });
      return;
    }
    const fileName = safeFileName(String(name));
    // The folder's summary note name is owned by the summarize feature so its
    // overwrite-on-rerun save can never clobber a hand-authored note.
    if (folderName && fileName.toLowerCase() === summaryFileName(folderName).toLowerCase()) {
      res.status(409).json({ error: "that name is reserved for the folder summary" });
      return;
    }
    const dir = folderName ? resolveInNotes(folderName) : NOTES_DIR;
    await fs.mkdir(dir, { recursive: true });
    const target = resolveInNotes(folderName, fileName);
    try {
      await fs.writeFile(target, "", { flag: "wx" });
    } catch {
      res.status(409).json({ error: "a note with that name already exists" });
      return;
    }
    res.json({ ok: true, folder: folderName, name: fileName });
  }),
);

// Rename a note within its folder.
app.post(
  "/api/note/rename",
  handler(async (req, res) => {
    const { folder = "", name = "", newName = "" } = req.body ?? {};
    if (typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (typeof newName !== "string" || !newName.trim()) {
      res.status(400).json({ error: "newName is required" });
      return;
    }
    const folderName = folder ? safeFolderName(String(folder)) : "";
    if (folder && !folderName) {
      res.status(400).json({ error: "invalid folder name" });
      return;
    }
    // The folder's summary note name is reserved for the summarize feature.
    if (folderName && safeFileName(newName).toLowerCase() === summaryFileName(folderName).toLowerCase()) {
      res.status(409).json({ error: "that name is reserved for the folder summary" });
      return;
    }
    const dir = folderName ? resolveInNotes(folderName) : NOTES_DIR;
    const fromPath = resolveInNotes(folderName, safeFileName(name));
    const toPath = resolveInNotes(folderName, safeFileName(newName));
    // Dedupe rather than silently overwriting an existing note of the target name.
    const finalName =
      toPath === fromPath ? safeFileName(newName) : await uniqueName(dir, safeFileName(newName));
    await fs.rename(fromPath, path.join(dir, finalName));
    res.json({ ok: true, folder: folderName, name: finalName });
  }),
);

// Move a note to another folder ("" = unfiled).
app.post(
  "/api/note/move",
  handler(async (req, res) => {
    const { folder = "", name = "", toFolder = "" } = req.body ?? {};
    const fromFolder = folder ? safeFolderName(String(folder)) : "";
    const dest = toFolder ? safeFolderName(String(toFolder)) : "";
    if (toFolder && !dest) {
      res.status(400).json({ error: "invalid destination folder" });
      return;
    }
    const fileName = safeFileName(String(name));
    if (dest) await fs.mkdir(resolveInNotes(dest), { recursive: true });
    const destName = await uniqueName(dest ? resolveInNotes(dest) : NOTES_DIR, fileName);
    await fs.rename(resolveInNotes(fromFolder, fileName), resolveInNotes(dest, destName));
    res.json({ ok: true, folder: dest, name: destName });
  }),
);

// Delete a note → move into the recycle bin.
app.post(
  "/api/note/delete",
  handler(async (req, res) => {
    const { folder = "", name = "" } = req.body ?? {};
    const folderName = folder ? safeFolderName(String(folder)) : "";
    const fileName = safeFileName(String(name));
    await fs.mkdir(TRASH_DIR, { recursive: true });
    const id = makeId();
    await fs.rename(resolveInNotes(folderName, fileName), path.join(TRASH_DIR, `${id}.md`));
    const manifest = await readManifest();
    manifest.push({
      id,
      originalName: fileName,
      originalFolder: folderName,
      deletedAt: new Date().toISOString(),
    });
    await writeManifest(manifest);
    res.json({ ok: true });
  }),
);

// Create a folder.
app.post(
  "/api/folder/create",
  handler(async (req, res) => {
    const folderName = safeFolderName(String((req.body ?? {}).name ?? ""));
    if (!folderName) {
      res.status(400).json({ error: "invalid folder name" });
      return;
    }
    await fs.mkdir(resolveInNotes(folderName), { recursive: true });
    res.json({ ok: true, name: folderName });
  }),
);

// Rename a folder (errors if a folder with the new name already exists).
app.post(
  "/api/folder/rename",
  handler(async (req, res) => {
    const { name = "", newName = "" } = req.body ?? {};
    const folderName = safeFolderName(String(name));
    const newFolderName = safeFolderName(String(newName));
    if (!folderName) {
      res.status(400).json({ error: "invalid folder name" });
      return;
    }
    if (!newFolderName) {
      res.status(400).json({ error: "invalid new folder name" });
      return;
    }
    const fromPath = resolveInNotes(folderName);
    const toPath = resolveInNotes(newFolderName);
    if (toPath === fromPath) {
      res.json({ ok: true, name: folderName });
      return;
    }
    try {
      await fs.access(toPath);
      res.status(409).json({ error: "a folder with that name already exists" });
      return;
    } catch {
      // target free — proceed
    }
    await fs.rename(fromPath, toPath);
    res.json({ ok: true, name: newFolderName });
  }),
);

// Delete a folder: move all its notes to the recycle bin, then remove the dir.
app.post(
  "/api/folder/delete",
  handler(async (req, res) => {
    const folderName = safeFolderName(String((req.body ?? {}).name ?? ""));
    if (!folderName) {
      res.status(400).json({ error: "invalid folder name" });
      return;
    }
    const dir = resolveInNotes(folderName);
    await fs.mkdir(TRASH_DIR, { recursive: true });
    const manifest = await readManifest();
    for (const fileName of await listMd(dir, "name")) {
      const id = makeId();
      await fs.rename(path.join(dir, fileName), path.join(TRASH_DIR, `${id}.md`));
      manifest.push({
        id,
        originalName: fileName,
        originalFolder: folderName,
        deletedAt: new Date().toISOString(),
      });
    }
    await writeManifest(manifest);
    await fs.rm(dir, { recursive: true, force: true });
    res.json({ ok: true });
  }),
);

// --- Recycle bin ------------------------------------------------------------
app.get(
  "/api/trash",
  handler(async (_req, res) => {
    const manifest = await readManifest();
    const items = [...manifest].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    res.json({ items });
  }),
);

app.post(
  "/api/trash/restore",
  handler(async (req, res) => {
    const id = String((req.body ?? {}).id ?? "");
    const manifest = await readManifest();
    const entry = manifest.find((e) => e.id === id);
    if (!entry) {
      res.status(404).json({ error: "trash entry not found" });
      return;
    }
    const dir = entry.originalFolder ? resolveInNotes(entry.originalFolder) : NOTES_DIR;
    await fs.mkdir(dir, { recursive: true });
    const destName = await uniqueName(dir, entry.originalName);
    await fs.rename(path.join(TRASH_DIR, `${id}.md`), path.join(dir, destName));
    await writeManifest(manifest.filter((e) => e.id !== id));
    res.json({ ok: true, folder: entry.originalFolder, name: destName });
  }),
);

app.post(
  "/api/trash/delete",
  handler(async (req, res) => {
    const id = String((req.body ?? {}).id ?? "");
    const manifest = await readManifest();
    if (!manifest.some((e) => e.id === id)) {
      res.status(404).json({ error: "trash entry not found" });
      return;
    }
    await fs.rm(path.join(TRASH_DIR, `${id}.md`), { force: true });
    await writeManifest(manifest.filter((e) => e.id !== id));
    res.json({ ok: true });
  }),
);

app.post(
  "/api/trash/empty",
  handler(async (_req, res) => {
    const manifest = await readManifest();
    await Promise.all(
      manifest.map((e) => fs.rm(path.join(TRASH_DIR, `${e.id}.md`), { force: true })),
    );
    await writeManifest([]);
    res.json({ ok: true });
  }),
);

app.listen(PORT, () => {
  console.log(`noter server listening on http://localhost:${PORT}`);
  console.log(`notes dir: ${NOTES_DIR}`);
});
