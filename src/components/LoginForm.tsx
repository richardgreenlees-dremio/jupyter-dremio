import * as React from 'react';
import { useState } from 'react';
import { DremioCloudRegion, DremioEnvironment } from '../api';

interface Props {
  onLogin: (url: string, username: string, password: string, useTls: boolean) => void;
  onSsoLogin: (url: string, useTls: boolean) => void;
  onCloudLogin: (environment: 'cloud-gen1' | 'cloud-gen2', projectId: string, token: string, region: DremioCloudRegion) => void;
  error: string | null;
  direct: boolean;
}

const LS_URL      = 'jupyter-dremio:url';
const LS_USERNAME = 'jupyter-dremio:username';
const LS_ENVIRONMENT = 'jupyter-dremio:environment';
const LS_PROJECT_ID = 'jupyter-dremio:project-id';
const LS_CLOUD_REGION = 'jupyter-dremio:cloud-region';

function saved(key: string): string {
  try { return localStorage.getItem(key) ?? ''; } catch { return ''; }
}

function persist(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

export function LoginForm({ onLogin, onSsoLogin, onCloudLogin, error, direct }: Props): JSX.Element {
  const [url, setUrl]       = useState(() => saved(LS_URL));
  const [environment, setEnvironment] = useState<DremioEnvironment>(
    () => (saved(LS_ENVIRONMENT) as DremioEnvironment) || 'software'
  );
  const [projectId, setProjectId] = useState(() => saved(LS_PROJECT_ID));
  const [cloudRegion, setCloudRegion] = useState<DremioCloudRegion>(
    () => (saved(LS_CLOUD_REGION) as DremioCloudRegion) || 'us'
  );
  const [token, setToken] = useState('');
  const [username, setUsername] = useState(() => saved(LS_USERNAME));
  const [password, setPassword] = useState('');
  const [showCredentials, setShowCredentials] = useState(direct);
  const [busy, setBusy] = useState(false);
  const [useTls, setUseTls] = useState(true);
  const isCloud = environment !== 'software';

  const handleEnvironmentChange = (value: DremioEnvironment) => {
    setEnvironment(value);
    persist(LS_ENVIRONMENT, value);
    setShowCredentials(value !== 'software' || direct);
  };

  const handleCloudLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId.trim() || !token.trim() || !isCloud) return;
    persist(LS_PROJECT_ID, projectId.trim());
    setBusy(true);
    try {
      onCloudLogin(environment, projectId.trim(), token.trim(), cloudRegion);
    } finally {
      setBusy(false);
    }
  };

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
        <label className="dremio-login-label">Environment</label>
        <select
          className="dremio-login-input"
          value={environment}
          onChange={e => handleEnvironmentChange(e.target.value as DremioEnvironment)}
          disabled={busy}
        >
          <option value="software">Dremio Software</option>
          <option value="cloud-gen1">Dremio Cloud — Gen 1</option>
          <option value="cloud-gen2">Dremio Cloud — Gen 2</option>
        </select>
      </div>

      {!isCloud && <div className="dremio-login-field">
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
      </div>}

      {isCloud && (
        <form onSubmit={handleCloudLogin}>
          <div className="dremio-login-field">
            <label className="dremio-login-label">Project ID</label>
            <input className="dremio-login-input" value={projectId} onChange={e => setProjectId(e.target.value)} disabled={busy} autoComplete="off" />
          </div>
          <div className="dremio-login-field">
            <label className="dremio-login-label">Control plane region</label>
            <select
              className="dremio-login-input"
              value={cloudRegion}
              onChange={e => {
                const region = e.target.value as DremioCloudRegion;
                setCloudRegion(region);
                persist(LS_CLOUD_REGION, region);
              }}
              disabled={busy}
            >
              <option value="us">US</option>
              <option value="eu">Europe</option>
            </select>
          </div>
          <div className="dremio-login-field">
            <label className="dremio-login-label">Personal Access Token</label>
            <input className="dremio-login-input" type="password" value={token} onChange={e => setToken(e.target.value)} disabled={busy} autoComplete="off" />
          </div>
          <button className="dremio-login-btn dremio-login-btn--primary" type="submit" disabled={busy || !projectId.trim() || !token.trim()}>
            {busy ? 'Connecting…' : 'Connect to Dremio Cloud'}
          </button>
        </form>
      )}

      {!isCloud && !direct && !showCredentials && (
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

      {!isCloud && showCredentials && (
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

      {!isCloud && <label className="dremio-login-tls">
        <input
          type="checkbox"
          checked={useTls}
          onChange={e => setUseTls(e.target.checked)}
          disabled={busy}
        />
        Use TLS
      </label>}

      {isCloud && (
        <div className="dremio-login-notice">Cloud uses the Dremio Cloud API with a Bearer token. The token is kept only for this session.</div>
      )}

      {!isCloud && direct && (
        <div className="dremio-login-notice">
          Direct mode — browser connects to Dremio directly (SSO unavailable).
        </div>
      )}
    </div>
  );
}
