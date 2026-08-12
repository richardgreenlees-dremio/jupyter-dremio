import * as React from 'react';
import { useState, useCallback, useEffect } from 'react';
import { LoginForm } from './LoginForm';
import { Toolbar } from './Toolbar';
import { CatalogNode } from './CatalogNode';
import {
  DremioCredentials,
  CatalogItem,
  login,
  ssoLogin,
  ssoLogout,
  fetchRootCatalog,
  fetchWiki,
  fetchCatalogSearch,
  createFolder,
  detectServerExtension,
} from '../api';

type Mode = 'detecting' | 'proxy' | 'direct';

interface Props {
  onShowWiki: (
    name: string,
    markdown: string,
    itemId: string,
    version: number | undefined,
    creds: DremioCredentials
  ) => void;
  onShowJobs: (creds: DremioCredentials) => void;
  onNewNotebook: (creds: DremioCredentials, item: CatalogItem | null) => void;
}

export function DremioPanel({ onShowWiki, onShowJobs, onNewNotebook }: Props): JSX.Element {
  const [mode, setMode] = useState<Mode>('detecting');
  const [creds, setCreds] = useState<DremioCredentials | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [rootItems, setRootItems] = useState<CatalogItem[]>([]);
  const [rootLoading, setRootLoading] = useState(false);
  const [rootError, setRootError] = useState<string | null>(null);
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedItem, setSelectedItem] = useState<CatalogItem | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [activeQuery, setActiveQuery] = useState('');   // committed query (debounce or Enter)
  const [searchResults, setSearchResults] = useState<CatalogItem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchDiag, setSearchDiag] = useState<string | null>(null);
  const [searchExpanded, setSearchExpanded] = useState(true);

  useEffect(() => {
    detectServerExtension().then(hasProxy => {
      setMode(hasProxy ? 'proxy' : 'direct');
    });
  }, []);

  // Debounce: commit the query 400ms after the user stops typing
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchQuery.trim() !== activeQuery.trim()) {
        setActiveQuery(searchQuery);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // Run search whenever the committed query changes
  useEffect(() => {
    const q = activeQuery.trim();
    if (!creds || !q) {
      setSearchResults([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    fetchCatalogSearch(creds, q)
      .then(data => {
        setSearchResults(data.data ?? []);
        setSearchExpanded(true);
        if ((data.data ?? []).length === 0) {
          setSearchDiag(
            data._rawKeys
              ? `API returned 0 matches. Response keys: ${data._rawKeys}`
              : 'API returned an empty response.'
          );
        } else {
          setSearchDiag(null);
        }
      })
      .catch(e => {
        setSearchError(e instanceof Error ? e.message : String(e));
        setSearchDiag(null);
      })
      .finally(() => setSearchLoading(false));
  }, [creds, activeQuery, catalogRevision]);

  const selected = selectedItem?.id ?? null;

  const handleExpandedChange = useCallback((id: string, expanded: boolean) => {
    setExpandedIds(previous => {
      const next = new Set(previous);
      if (expanded) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const loadRoot = useCallback(async (c: DremioCredentials) => {
    setRootLoading(true);
    setRootError(null);
    try {
      const data = await fetchRootCatalog(c);
      setRootItems(data.data ?? []);
      setCatalogRevision(revision => revision + 1);
    } catch (e) {
      setRootError(e instanceof Error ? e.message : String(e));
    } finally {
      setRootLoading(false);
    }
  }, []);

  const handleLogin = async (url: string, username: string, password: string, useTls: boolean) => {
    setLoginError(null);
    try {
      const direct = mode === 'direct';
      const resp = await login(url, username, password, direct);
      const c: DremioCredentials = { url, token: resp.token, direct, username: resp.userName, password, useTls };
      setCreds(c);
      await loadRoot(c);
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSsoLogin = async (url: string, useTls: boolean) => {
    setLoginError(null);
    try {
      const resp = await ssoLogin(url);
      const c: DremioCredentials = { url, token: resp.token, direct: false, username: resp.userName, useTls };
      setCreds(c);
      await loadRoot(c);
    } catch (e) {
      setLoginError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleLogout = () => {
    if (creds?.token.startsWith('__sso__')) {
      ssoLogout(creds.url).catch(() => undefined);
    }
    setCreds(null);
    setRootItems([]);
    setExpandedIds(new Set());
    setSelectedItem(null);
    setLoginError(null);
    setSearchQuery('');
    setActiveQuery('');
    setSearchResults([]);
    setSearchError(null);
    setSearchDiag(null);
  };

  const handleRefreshRoot = useCallback(async () => {
    if (creds) await loadRoot(creds);
  }, [creds, loadRoot]);

  const handleCreateFolder = useCallback(async () => {
    if (!creds || !selectedItem) return;
    if (selectedItem.containerType !== 'SPACE' && selectedItem.containerType !== 'FOLDER') {
      alert('Please select a folder or space first.');
      return;
    }
    const folderName = window.prompt('Folder name:');
    if (!folderName?.trim()) return;
    try {
      await createFolder(creds, [...selectedItem.path, folderName.trim()]);
    } catch (e) {
      alert(`Create folder failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [creds, selectedItem]);

  const handleOpenWiki = useCallback(
    async (item: CatalogItem) => {
      if (!creds) return;
      const name = item.path[item.path.length - 1] ?? item.id;
      try {
        const wiki = await fetchWiki(creds, item.id);
        onShowWiki(name, wiki.text ?? '', item.id, wiki.version, creds);
      } catch {
        onShowWiki(name, '_Wiki could not be loaded for this item._', item.id, undefined, creds);
      }
    },
    [creds, onShowWiki]
  );

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      setActiveQuery(searchQuery);
    }
  };

  const handleClearSearch = () => {
    setSearchQuery('');
    setActiveQuery('');
    setSearchResults([]);
    setSearchError(null);
    setSearchDiag(null);
  };

  if (mode === 'detecting') {
    return <div className="dremio-detecting">Connecting…</div>;
  }

  if (!creds) {
    return (
      <LoginForm
        onLogin={handleLogin}
        onSsoLogin={handleSsoLogin}
        error={loginError}
        direct={mode === 'direct'}
      />
    );
  }

  const hasActiveSearch = activeQuery.trim().length > 0;

  return (
    <div className="dremio-panel">
      <Toolbar
        creds={creds}
        selected={selected}
        selectedItem={selectedItem}
        onRefreshRoot={handleRefreshRoot}
        onLogout={handleLogout}
        onCreateFolder={() => { void handleCreateFolder(); }}
        onShowJobs={() => onShowJobs(creds)}
        onNewNotebook={() => onNewNotebook(creds, selectedItem)}
      />
      <div className="dremio-search-bar">
        <input
          className="dremio-search-input"
          type="search"
          placeholder="Search catalog…"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          aria-label="Search Dremio catalog"
        />
        {searchQuery && (
          <button
            className="dremio-search-clear"
            onClick={handleClearSearch}
            title="Clear search"
          >
            ×
          </button>
        )}
      </div>
      <div className="dremio-catalog-tree">
        {/* ── Virtual "Search Results" node — always on top, only when query is active ── */}
        {hasActiveSearch && (
          <div className="dremio-node">
            <div
              className="dremio-node-row"
              style={{ paddingLeft: '6px' }}
              onClick={() => setSearchExpanded(prev => !prev)}
            >
              <span className={`dremio-chevron${searchExpanded ? ' dremio-chevron--open' : ''}`}>
                ›
              </span>
              <span className="dremio-node-icon">🔍</span>
              <span className="dremio-node-label">
                Search Results
                {!searchLoading && searchResults.length > 0 && (
                  <span className="dremio-search-count"> ({searchResults.length})</span>
                )}
              </span>
              {searchLoading && (
                <span className="dremio-search-spinner">…</span>
              )}
            </div>
            {searchExpanded && (
              <div className="dremio-node-children">
                {searchError && (
                  <div className="dremio-node-error" style={{ paddingLeft: '24px' }}>
                    Search error: {searchError}
                  </div>
                )}
                {!searchLoading && !searchError && searchResults.length === 0 && (
                  <div className="dremio-node-empty" style={{ paddingLeft: '24px' }}>
                    No results for &ldquo;{activeQuery}&rdquo;.
                    {searchDiag && (
                      <div className="dremio-search-diag">{searchDiag}</div>
                    )}
                  </div>
                )}
                {searchResults.map(item => (
                  <CatalogNode
                    key={item.id}
                    item={item}
                    creds={creds}
                    depth={1}
                    selected={selected}
                    onSelect={setSelectedItem}
                    onOpenWiki={handleOpenWiki}
                    onDeleteItem={id => setSearchResults(prev => prev.filter(i => i.id !== id))}
                    onCatalogChanged={handleRefreshRoot}
                    catalogRevision={catalogRevision}
                    expanded={expandedIds.has(item.id)}
                    expandedIds={expandedIds}
                    onExpandedChange={handleExpandedChange}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Normal catalog tree (always visible) ── */}
        {rootLoading && (
          <div className="dremio-root-loading">Loading catalog…</div>
        )}
        {rootError && (
          <div className="dremio-root-error">{rootError}</div>
        )}
        {!rootLoading &&
          rootItems.map(item => (
            <CatalogNode
              key={item.id}
              item={item}
              creds={creds}
              depth={0}
              selected={selected}
              onSelect={setSelectedItem}
              onOpenWiki={handleOpenWiki}
              onDeleteItem={id => {
                setRootItems(prev => prev.filter(i => i.id !== id));
                if (selectedItem?.id === id) setSelectedItem(null);
              }}
              onCatalogChanged={handleRefreshRoot}
              catalogRevision={catalogRevision}
              expanded={expandedIds.has(item.id)}
              expandedIds={expandedIds}
              onExpandedChange={handleExpandedChange}
            />
          ))}
        {!rootLoading && !rootError && rootItems.length === 0 && (
          <div className="dremio-root-empty">No catalog items found.</div>
        )}
      </div>
      <div className="dremio-panel-footer">
        <span title={creds.url}>⚡ {new URL(creds.url).hostname}</span>
        {creds.direct && (
          <span
            className="dremio-mode-badge"
            title="Requests go directly from your browser to Dremio"
          >
            direct
          </span>
        )}
      </div>
    </div>
  );
}
