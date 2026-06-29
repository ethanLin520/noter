import Database from "better-sqlite3";
import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response, NextFunction } from "express";

/**
 * Authentication + per-user storage roots.
 *
 * Users and sessions live in a small SQLite DB; the notes themselves stay on
 * the filesystem under `notes/<userId>/`. Passwords are hashed with the
 * built-in scrypt KDF (no bcrypt dependency); sessions are opaque random tokens
 * set as an httpOnly cookie. Accounts are created by an admin via add-user.ts
 * (there is no public signup).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Parent container for every user's notes dir. */
export const NOTES_DIR = path.resolve(__dirname, "../../notes");
/** SQLite file; defaults beside the notes tree (both are gitignored). */
const DB_PATH = process.env.NOTER_DB ?? path.join(NOTES_DIR, ".noter.db");

export const SESSION_COOKIE = "noter_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const KEY_LEN = 64;

// --- DB init ----------------------------------------------------------------
mkdirSync(path.dirname(DB_PATH), { recursive: true }); // better-sqlite3 needs the dir to exist
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL"); // safe concurrent reads alongside the single writer
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user',
    created_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

// --- Types ------------------------------------------------------------------
/** A user without secrets — safe to attach to a request. */
export interface User {
  id: string;
  email: string;
  display_name: string;
  role: string;
  created_at: number;
}
interface UserRow extends User {
  password_hash: string;
  salt: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

const USER_COLS = "id, email, display_name, role, created_at";

// --- Password hashing (scrypt) ---------------------------------------------
const scryptAsync = promisify(scrypt);

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = randomBytes(16).toString("hex");
  const dk = (await scryptAsync(password, salt, KEY_LEN)) as Buffer;
  return { hash: dk.toString("hex"), salt };
}

export async function verifyPassword(
  password: string,
  hashHex: string,
  salt: string,
): Promise<boolean> {
  const dk = (await scryptAsync(password, salt, KEY_LEN)) as Buffer;
  const stored = Buffer.from(hashHex, "hex");
  // Length check first so timingSafeEqual (which throws on length mismatch) is safe.
  return stored.length === dk.length && timingSafeEqual(stored, dk);
}

/**
 * A syntactically valid hash/salt to verify against when the email is unknown,
 * so login always runs the (slow) scrypt KDF and timing can't reveal whether an
 * account exists. The value never matches a real password.
 */
export const DUMMY_CREDENTIAL = { hash: "0".repeat(KEY_LEN * 2), salt: "0".repeat(32) };

/** Short, filesystem-safe id (also the user's notes dir name). */
function newId(): string {
  return randomBytes(6).toString("base64url");
}

/** Strip secrets for sending to the client. */
export function publicUser(u: User): { id: string; email: string; displayName: string; role: string } {
  return { id: u.id, email: u.email, displayName: u.display_name, role: u.role };
}

// --- Users ------------------------------------------------------------------
export async function createUser(
  email: string,
  password: string,
  displayName: string,
  role: "admin" | "user" = "user",
): Promise<User> {
  const normEmail = email.trim().toLowerCase();
  if (!normEmail) throw new Error("email is required");
  if (!password) throw new Error("password is required");
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(normEmail)) {
    throw new Error(`a user with email ${normEmail} already exists`);
  }
  const name = displayName.trim() || normEmail;
  const { hash, salt } = await hashPassword(password);
  const id = newId();
  const created_at = Date.now();
  db.prepare(
    `INSERT INTO users (id, email, password_hash, salt, display_name, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, normEmail, hash, salt, name, role, created_at);
  return { id, email: normEmail, display_name: name, role, created_at };
}

export function getUserByEmail(email: string): UserRow | undefined {
  return db
    .prepare(`SELECT ${USER_COLS}, password_hash, salt FROM users WHERE email = ?`)
    .get(email.trim().toLowerCase()) as UserRow | undefined;
}

// --- Sessions ---------------------------------------------------------------
export function createSession(userId: string): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(token, userId, now, expiresAt);
  return { token, expiresAt };
}

/** Resolve the user for a session token; drops and ignores expired sessions. */
export function getSessionUser(token: string): User | undefined {
  const row = db
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.role, u.created_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`,
    )
    .get(token) as (User & { expires_at: number }) | undefined;
  if (!row) return undefined;
  if (row.expires_at <= Date.now()) {
    deleteSession(token);
    return undefined;
  }
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    created_at: row.created_at,
  };
}

export function deleteSession(token: string): void {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function pruneExpiredSessions(): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
}

// --- Request helpers --------------------------------------------------------
/** A user's notes root: notes/<userId>/. The single source of this layout. */
export function userRootFor(userId: string): string {
  return path.join(NOTES_DIR, userId);
}

// Roots already created this process, so the blocking mkdir runs at most once
// per user (requireAuth is on every authenticated request, including each
// autocomplete keystroke).
const ensuredRoots = new Set<string>();
/** Create a user's notes dir on first use (idempotent, memoized). */
export function ensureUserDir(userRoot: string): void {
  if (ensuredRoots.has(userRoot)) return;
  mkdirSync(userRoot, { recursive: true });
  ensuredRoots.add(userRoot);
}

/** Read a single named cookie from the request (avoids a cookie-parser dep). */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return undefined;
}

/** Gate: attach req.user from the session cookie, or 401. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = readCookie(req, SESSION_COOKIE);
  const user = token ? getSessionUser(token) : undefined;
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  req.user = user;
  ensureUserDir(userRootFor(user.id));
  next();
}
