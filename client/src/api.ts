// Typed fetch helpers for the backend. All paths go through the Vite /api proxy.
// Every request sends the session cookie (`credentials: "include"`); a 401 from
// any call notifies the registered handler so the app can drop back to login.

let onUnauthorized: (() => void) | null = null;

/** App registers a callback here to react to a dropped/expired session. */
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

/** Notify + throw on 401 so a single code path bounces the app to login. */
function check(res: Response): Response {
  if (res.status === 401) {
    onUnauthorized?.();
    throw new Error("unauthorized");
  }
  return res;
}

/** fetch + session cookie + 401 bounce + server-error-to-throw; returns the raw Response. */
async function request(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, { credentials: "include", ...init });
  check(res);
  if (!res.ok) {
    const msg = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(msg.error ?? `request failed: ${res.status}`);
  }
  return res;
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  return res.json() as Promise<T>;
}

// --- Auth -------------------------------------------------------------------

// Mirrors the server's publicUser() shape (server/src/auth.ts). Keep in sync.
export interface Me {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

/** Current user, or null when not logged in (401 is expected, not an error). */
export async function me(): Promise<Me | null> {
  const res = await fetch("/api/me", { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error("failed to load session");
  const data = (await res.json()) as { user: Me };
  return data.user;
}

/** Log in. Bypasses check(): a 401 here is bad credentials, not a dropped session. */
export async function login(email: string, password: string): Promise<Me> {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ email, password }),
  });
  if (res.status === 401) throw new Error("Invalid email or password");
  if (!res.ok) {
    const msg = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(msg.error ?? `login failed: ${res.status}`);
  }
  const data = (await res.json()) as { user: Me };
  return data.user;
}

export async function logout(): Promise<void> {
  await fetch("/api/logout", { method: "POST", credentials: "include" });
}

// --- LLM features -----------------------------------------------------------

export async function autocomplete(
  context: string,
  currentLine: string,
  signal?: AbortSignal,
): Promise<string> {
  const data = await postJson<{ suggestion: string }>(
    "/api/autocomplete",
    { context, currentLine },
    signal,
  );
  return data.suggestion;
}

export interface SanitizeResponse {
  result: string;
  sessionId: string;
  needsClarification: boolean;
}

export function sanitize(notes: string): Promise<SanitizeResponse> {
  return postJson<SanitizeResponse>("/api/sanitize", { notes });
}

export function sanitizeReply(sessionId: string, answers: string): Promise<SanitizeResponse> {
  return postJson<SanitizeResponse>("/api/sanitize/reply", { sessionId, answers });
}

export interface FolderSummaryResponse {
  result: string;
  sessionId: string;
}

/** Roll up every note in a folder (skipping its own summary) into one digest. */
export function summarizeFolder(folder: string): Promise<FolderSummaryResponse> {
  return postJson<FolderSummaryResponse>("/api/folder/summarize", { folder });
}

/** Steer a prior folder summary (resumes its session) with an instruction. */
export function refineSummary(
  sessionId: string,
  instruction: string,
): Promise<FolderSummaryResponse> {
  return postJson<FolderSummaryResponse>("/api/folder/summarize/reply", {
    sessionId,
    instruction,
  });
}

// --- Export -----------------------------------------------------------------

/** Server-rendered PDF (md-to-pdf + github-markdown-css). Returns the PDF blob. */
export async function exportPdf(name: string, markdown: string): Promise<Blob> {
  const res = await request("/api/export/pdf", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, markdown }),
  });
  return res.blob();
}

// --- Search -----------------------------------------------------------------

export interface SearchResult {
  folder: string;
  name: string;
  snippet: string;
}

export async function searchNotes(q: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
    signal,
    credentials: "include",
  });
  check(res);
  if (!res.ok) throw new Error("search failed");
  const data = (await res.json()) as { results: SearchResult[] };
  return data.results;
}

// --- Notes & folders --------------------------------------------------------

export interface Tree {
  unfiled: string[];
  folders: { name: string; notes: string[] }[];
  trashCount: number;
}

export interface TrashItem {
  id: string;
  originalName: string;
  originalFolder: string;
  deletedAt: string;
}

export type SortMode = "edited-desc" | "edited-asc" | "name";

export async function getTree(sort: SortMode = "edited-desc"): Promise<Tree> {
  const res = await fetch(`/api/tree?sort=${sort}`, { credentials: "include" });
  check(res);
  if (!res.ok) throw new Error("failed to load notes");
  return (await res.json()) as Tree;
}

export function saveNote(
  folder: string,
  name: string,
  markdown: string,
  /** When true, the server dedupes the name so a new note can't overwrite an existing file. */
  createNew = false,
): Promise<{ ok: boolean; folder: string; name: string }> {
  return postJson("/api/save", { folder, name, markdown, createNew });
}

export interface LoadedNote {
  markdown: string;
  /** ISO timestamp of the file's last modification. */
  mtime: string;
}

export async function loadNote(folder: string, name: string): Promise<LoadedNote> {
  const params = new URLSearchParams({ folder, name });
  const res = await fetch(`/api/note?${params.toString()}`, { credentials: "include" });
  check(res);
  if (!res.ok) throw new Error("failed to load note");
  const data = (await res.json()) as { markdown: string; mtime: string };
  return { markdown: data.markdown, mtime: data.mtime };
}

export function createNote(
  folder: string,
  name: string,
): Promise<{ ok: boolean; folder: string; name: string }> {
  return postJson("/api/note/create", { folder, name });
}

export function renameNote(
  folder: string,
  name: string,
  newName: string,
): Promise<{ ok: boolean; folder: string; name: string }> {
  return postJson("/api/note/rename", { folder, name, newName });
}

export function moveNote(
  folder: string,
  name: string,
  toFolder: string,
): Promise<{ ok: boolean; folder: string; name: string }> {
  return postJson("/api/note/move", { folder, name, toFolder });
}

export function deleteNote(folder: string, name: string): Promise<{ ok: boolean }> {
  return postJson("/api/note/delete", { folder, name });
}

export function createFolder(name: string): Promise<{ ok: boolean; name: string }> {
  return postJson("/api/folder/create", { name });
}

export function renameFolder(
  name: string,
  newName: string,
): Promise<{ ok: boolean; name: string }> {
  return postJson("/api/folder/rename", { name, newName });
}

export function deleteFolder(name: string): Promise<{ ok: boolean }> {
  return postJson("/api/folder/delete", { name });
}

export async function getTrash(): Promise<TrashItem[]> {
  const res = await fetch("/api/trash", { credentials: "include" });
  check(res);
  if (!res.ok) throw new Error("failed to load trash");
  const data = (await res.json()) as { items: TrashItem[] };
  return data.items;
}

export function restoreTrash(id: string): Promise<{ ok: boolean }> {
  return postJson("/api/trash/restore", { id });
}

export function purgeTrash(id: string): Promise<{ ok: boolean }> {
  return postJson("/api/trash/delete", { id });
}

export function emptyTrash(): Promise<{ ok: boolean }> {
  return postJson("/api/trash/empty", {});
}
