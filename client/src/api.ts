// Typed fetch helpers for the backend. All paths go through the Vite /api proxy.

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(msg.error ?? `request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

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

// --- Search -----------------------------------------------------------------

export interface SearchResult {
  folder: string;
  name: string;
  snippet: string;
}

export async function searchNotes(q: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal });
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

export type SortMode = "created-desc" | "created-asc" | "name";

export async function getTree(sort: SortMode = "created-desc"): Promise<Tree> {
  const res = await fetch(`/api/tree?sort=${sort}`);
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

export async function loadNote(folder: string, name: string): Promise<string> {
  const params = new URLSearchParams({ folder, name });
  const res = await fetch(`/api/note?${params.toString()}`);
  if (!res.ok) throw new Error("failed to load note");
  const data = (await res.json()) as { markdown: string };
  return data.markdown;
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
  const res = await fetch("/api/trash");
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
