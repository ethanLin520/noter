import { useState } from "react";
import { login, type Me } from "./api";

/** Full-screen email + password gate. Reuses the modal/button/input styles. */
export default function Login({ onSuccess }: { onSuccess: (user: Me) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const user = await login(email.trim(), password);
      onSuccess(user); // App swaps to the app view (this component unmounts)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setPassword("");
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="modal login-card" onSubmit={submit}>
        <div className="modal-header">
          <h2>
            <img className="logo-icon" src="/noter-icon.svg" alt="" aria-hidden="true" />
            Noter
          </h2>
        </div>
        <div className="modal-body">
          <label className="login-field">
            <span>Email</span>
            <input
              className="search-input"
              type="email"
              autoComplete="username"
              value={email}
              autoFocus
              required
              disabled={busy}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="login-field">
            <span>Password</span>
            <input
              className="search-input"
              type="password"
              autoComplete="current-password"
              value={password}
              required
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="modal-actions">
            <button
              className="btn-primary"
              type="submit"
              disabled={busy || !email.trim() || !password}
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
