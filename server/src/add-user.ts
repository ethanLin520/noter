/**
 * Admin CLI to create a user account (there is no public signup).
 *
 *   npm run add-user -- <email> <password> [display name...] [--admin]
 *
 * Writes to the same SQLite DB the server uses (see auth.ts / NOTER_DB).
 */
import { createUser } from "./auth.js";

const argv = process.argv.slice(2);
const admin = argv.includes("--admin");
const [email, password, ...nameParts] = argv.filter((a) => a !== "--admin");
const displayName = nameParts.join(" ");

if (!email || !password) {
  console.error("usage: npm run add-user -- <email> <password> [display name] [--admin]");
  process.exit(1);
}

createUser(email, password, displayName, admin ? "admin" : "user")
  .then((user) => {
    console.log(`created ${user.email} (id ${user.id}, role ${user.role})`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(`error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
