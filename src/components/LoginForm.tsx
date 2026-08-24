import * as React from 'react';
import { useEffect, useState } from 'react';
import {
  DremioCloudRegion,
  DremioEnvironment,
  fetchOidcProviders,
  fetchSoftwareInstances,
  OidcProvider,
  SoftwareInstance,
} from '../api';

interface Props {
  onLogin: (url: string, username: string, password: string, useTls: boolean) => Promise<void>;
  onOidcLogin: (url: string, provider: string, useTls: boolean) => Promise<void>;
  onKerberosLogin: (url: string, useTls: boolean) => Promise<void>;
  onCloudLogin: (environment: 'cloud-gen1' | 'cloud-gen2', projectId: string, token: string, region: DremioCloudRegion) => Promise<void>;
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

export function LoginForm({ onLogin, onOidcLogin, onKerberosLogin, onCloudLogin, error, direct }: Props): JSX.Element {
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
  const [oidcProviders, setOidcProviders] = useState<OidcProvider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [providerError, setProviderError] = useState<string | null>(null);
  const [softwareInstances, setSoftwareInstances] = useState<SoftwareInstance[]>([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState('');
  const [instanceError, setInstanceError] = useState<string | null>(null);
  const [instancesLoading, setInstancesLoading] = useState(!direct);
  const [showOidcHelp, setShowOidcHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const isCloud = environment !== 'software';
  const selectedInstance = softwareInstances.find(instance => instance.id === selectedInstanceId);
  const effectiveUrl = selectedInstance?.url ?? url;

  useEffect(() => {
    if (direct) return;
    fetchOidcProviders()
      .then(providers => {
        setOidcProviders(providers);
        setSelectedProvider(current => current || providers[0]?.id || '');
        setProviderError(null);
      })
      .catch(e => setProviderError(e instanceof Error ? e.message : String(e)));
    fetchSoftwareInstances()
      .then(instances => {
        setSoftwareInstances(instances);
        const rememberedUrl = saved(LS_URL).replace(/\/$/, '');
        const initial = instances.find(instance => instance.url === rememberedUrl) ?? instances[0];
        setSelectedInstanceId(initial?.id ?? '');
        if (initial) persist(LS_URL, initial.url);
        setInstanceError(null);
      })
      .catch(e => setInstanceError(e instanceof Error ? e.message : String(e)))
      .finally(() => setInstancesLoading(false));
  }, [direct]);

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
      await onCloudLogin(environment, projectId.trim(), token.trim(), cloudRegion);
    } finally {
      setBusy(false);
    }
  };

  const cleanDremioUrl = (): string => effectiveUrl.trim().replace(/\/$/, '');

  const handleOidc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveUrl.trim() || !selectedProvider) return;
    const cleanUrl = cleanDremioUrl();
    persist(LS_URL, cleanUrl);
    setBusy(true);
    try {
      await onOidcLogin(cleanUrl, selectedProvider, cleanUrl.startsWith('https://'));
    } finally {
      setBusy(false);
    }
  };

  const handleKerberos = async () => {
    if (!effectiveUrl.trim()) return;
    const cleanUrl = cleanDremioUrl();
    persist(LS_URL, cleanUrl);
    setBusy(true);
    try {
      await onKerberosLogin(cleanUrl, cleanUrl.startsWith('https://'));
    } finally {
      setBusy(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveUrl.trim() || !username.trim()) return;
    const cleanUrl = cleanDremioUrl();
    persist(LS_URL, cleanUrl);
    persist(LS_USERNAME, username.trim());
    setBusy(true);
    try {
      await onLogin(cleanUrl, username.trim(), password, cleanUrl.startsWith('https://'));
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

      {!isCloud && instancesLoading && (
        <div className="dremio-login-field">
          <label className="dremio-login-label">Dremio instance</label>
          <div className="dremio-login-instance">Loading configured instances…</div>
        </div>
      )}

      {!isCloud && !instancesLoading && softwareInstances.length === 1 && (
        <div className="dremio-login-field">
          <label className="dremio-login-label">Dremio instance</label>
          <div className="dremio-login-instance" title={softwareInstances[0].url}>
            <strong>{softwareInstances[0].label}</strong>
            <span>{new URL(softwareInstances[0].url).hostname}</span>
          </div>
        </div>
      )}

      {!isCloud && !instancesLoading && softwareInstances.length > 1 && (
        <div className="dremio-login-field">
          <label className="dremio-login-label">Dremio instance</label>
          <select
            className="dremio-login-input"
            value={selectedInstanceId}
            onChange={e => {
              const id = e.target.value;
              setSelectedInstanceId(id);
              const instance = softwareInstances.find(candidate => candidate.id === id);
              if (instance) persist(LS_URL, instance.url);
            }}
            disabled={busy}
          >
            {softwareInstances.map(instance => (
              <option key={instance.id} value={instance.id}>{instance.label}</option>
            ))}
          </select>
        </div>
      )}

      {!isCloud && !instancesLoading && softwareInstances.length === 0 && (
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
          {instanceError && <span className="dremio-login-field-help">Configured instances could not be loaded; enter the URL manually.</span>}
        </div>
      )}

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
        <form onSubmit={handleOidc}>
          {oidcProviders.length > 1 && (
            <div className="dremio-login-field">
              <label className="dremio-login-label">SSO provider</label>
              <select
                className="dremio-login-input"
                value={selectedProvider}
                onChange={e => setSelectedProvider(e.target.value)}
                disabled={busy}
              >
                {oidcProviders.map(provider => (
                  <option key={provider.id} value={provider.id}>{provider.label}</option>
                ))}
              </select>
            </div>
          )}
          {oidcProviders.length > 0 && (
            <button
              className="dremio-login-btn dremio-login-btn--primary"
              type="submit"
              disabled={busy || instancesLoading || !effectiveUrl.trim() || !selectedProvider}
            >
              {busy ? 'Connecting…' : `Sign in with ${oidcProviders.find(p => p.id === selectedProvider)?.label ?? 'SSO'}`}
            </button>
          )}
          {oidcProviders.length === 0 && !providerError && (
            <div className={`dremio-oidc-help${showOidcHelp ? ' dremio-oidc-help--open' : ''}`}>
              <button
                className="dremio-oidc-help-trigger"
                type="button"
                aria-expanded={showOidcHelp}
                aria-describedby="dremio-oidc-help-tooltip"
                onClick={() => setShowOidcHelp(open => !open)}
              >
                OIDC SSO is not configured on this Jupyter server. <span aria-hidden="true">ⓘ</span>
              </button>
              <div id="dremio-oidc-help-tooltip" className="dremio-oidc-help-tooltip" role="tooltip">
                Ask your Jupyter administrator to configure <code>JUPYTER_DREMIO_OIDC_PROVIDERS</code>
                {' '}with the provider issuer, client ID, scopes, credentials, and allowed Dremio URL.
                They must also register the Jupyter callback URL with the identity provider. Your Dremio
                administrator must configure a matching External Token Provider using the same issuer,
                audience, and username claim. Restart Jupyter after changing the configuration.
              </div>
            </div>
          )}
          {providerError && <div className="dremio-login-error">Cannot load SSO providers: {providerError}</div>}
          <button
            className={`dremio-login-btn ${oidcProviders.length === 0 ? 'dremio-login-btn--primary' : 'dremio-login-btn--link'}`}
            type="button"
            onClick={() => { void handleKerberos(); }}
            disabled={busy || instancesLoading || !effectiveUrl.trim()}
            title="Use Kerberos/SPNEGO with the Jupyter server's current Kerberos credentials."
          >
            {busy ? 'Connecting…' : 'Sign in with Kerberos'}
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
            disabled={busy || instancesLoading || !effectiveUrl.trim() || !username.trim()}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {!direct && (
            <button
              className="dremio-login-btn dremio-login-btn--link"
              type="button"
              onClick={() => setShowCredentials(false)}
            >
              Use SSO or Kerberos instead
            </button>
          )}
        </form>
      )}

      {error && <div className="dremio-login-error">{error}</div>}

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
