import * as React from 'react';
import { useState } from 'react';

interface Props {
  onLogin: (url: string, username: string, password: string, useTls: boolean) => void;
  onSsoLogin: (url: string, useTls: boolean) => void;
  error: string | null;
  direct: boolean;
}

const LS_URL      = 'jupyter-dremio:url';
const LS_USERNAME = 'jupyter-dremio:username';

function saved(key: string): string {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}

function persist(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

export function LoginForm({ onLogin, onSsoLogin, error, direct }: Props): JSX.Element {
  const [url, setUrl]       = useState(() => saved(LS_URL));
  const [username, setUsername] = useState(() => saved(LS_USERNAME));
  const [password, setPassword] = useState('');
  const [showCredentials, setShowCredentials] = useState(direct);
  const [busy, setBusy] = useState(false);
  const [useTls, setUseTls] = useState(true);

  const handleSso = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    const cleanUrl = url.trim().replace(/\/$/, '');
    persist(LS_URL, cleanUrl);
    setBusy(true);
    try {
      await onSsoLogin(cleanUrl, useTls);
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || !username.trim()) return;
    const cleanUrl = url.trim().replace(/\/$/, '');
    persist(LS_URL, cleanUrl);
    persist(LS_USERNAME, username.trim());
    setBusy(true);
    try {
      await onLogin(cleanUrl, username.trim(), password, useTls);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dremio-login">
      <div className="dremio-login-header">
        <span className="dremio-login-title">Dremio Catalog</span>
      </div>

      <div className="dremio-login-field">
        <label className="dremio-login-label">Dremio URL</label>
        <input
          className="dremio-login-input"
          type="url"
          placeholder="https://dremio.example.com"
          value={url}
          onChange={e => setUrl(e.target.value)}
          disabled={busy}
          autoComplete="url"
        />
      </div>

      {!direct && !showCredentials && (
        <form onSubmit={handleSso}>
          <button
            className="dremio-login-btn dremio-login-btn--primary"
            type="submit"
            disabled={busy || !url.trim()}
            title="Requires Kerberos/SPNEGO — only works on domain-joined machines where Dremio is configured for Negotiate auth. Use username &amp; password if unsure."
          >
            {busy ? 'Connecting…' : 'Log in with SSO (Kerberos)'}
          </button>
          <button
            className="dremio-login-btn dremio-login-btn--link"
            type="button"
            onClick={() => setShowCredentials(true)}
          >
            Use username &amp; password
          </button>
        </form>
      )}

      {showCredentials && (
        <form onSubmit={handleLogin}>
          <div className="dremio-login-field">
            <label className="dremio-login-label">Username</label>
            <input
              className="dremio-login-input"
              type="text"
              placeholder="user@example.com"
              value={username}
              onChange={e => setUsername(e.target.value)}
              disabled={busy}
              autoComplete="username"
            />
          </div>
          <div className="dremio-login-field">
            <label className="dremio-login-label">Password</label>
            <input
              className="dremio-login-input"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={e => setPassword(e.target.value)}
              disabled={busy}
              autoComplete="current-password"
            />
          </div>
          <button
            className="dremio-login-btn dremio-login-btn--primary"
            type="submit"
            disabled={busy || !url.trim() || !username.trim()}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {!direct && (
            <button
              className="dremio-login-btn dremio-login-btn--link"
              type="button"
              onClick={() => setShowCredentials(false)}
            >
              Use SSO instead
            </button>
          )}
        </form>
      )}

      {error && <div className="dremio-login-error">{error}</div>}

      <label className="dremio-login-tls">
        <input
          type="checkbox"
          checked={useTls}
          onChange={e => setUseTls(e.target.checked)}
          disabled={busy}
        />
        Use TLS
      </label>

      {direct && (
        <div className="dremio-login-notice">
          Direct mode — browser connects to Dremio directly (SSO unavailable).
        </div>
      )}
    </div>
  );
}
