import * as React from 'react';
import { DremioCredentials, CatalogItem, buildSqlPath } from '../api';

interface Props {
  creds: DremioCredentials;
  selectedItem: CatalogItem | null;
  onRefreshRoot: () => void;
  onLogout: () => void;
  onCreateFolder: () => void;
  onShowJobs: () => void;
  onNewNotebook: () => void;
}

function IconJobs(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2"/>
      <line x1="7" y1="8"  x2="17" y2="8"/>
      <line x1="7" y1="12" x2="17" y2="12"/>
      <line x1="7" y1="16" x2="13" y2="16"/>
    </svg>
  );
}

function IconNotebook(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="2" width="16" height="20" rx="2"/>
      <polyline points="8 9 11 12 8 15"/>
      <line x1="13" y1="15" x2="16" y2="15"/>
    </svg>
  );
}

function IconFolderPlus(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      <line x1="12" y1="11" x2="12" y2="17"/>
      <line x1="9" y1="14" x2="15" y2="14"/>
    </svg>
  );
}

function IconSignOut(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  );
}

export function Toolbar({
  creds,
  selectedItem,
  onRefreshRoot,
  onLogout,
  onCreateFolder,
  onShowJobs,
  onNewNotebook,
}: Props): JSX.Element {
  const canCreateFolder =
    selectedItem?.containerType === 'SPACE' || selectedItem?.containerType === 'FOLDER';

  return (
    <div className="dremio-toolbar">
      <button
        className="dremio-toolbar-btn"
        onClick={onRefreshRoot}
        title="Refresh catalog root"
        aria-label="Refresh"
      >
        ↺
      </button>

      <button
        className="dremio-toolbar-btn"
        onClick={onShowJobs}
        title="View Dremio jobs"
        aria-label="Jobs log"
      >
        <IconJobs />
      </button>

      <button
        className="dremio-toolbar-btn"
        onClick={onNewNotebook}
        title={`New notebook with Dremio connection (${creds.username ?? creds.url})`}
        aria-label="New Dremio notebook"
      >
        <IconNotebook />
      </button>

      {selectedItem && (
        <button
          className="dremio-toolbar-btn"
          onClick={() => void navigator.clipboard.writeText(buildSqlPath(selectedItem.path))}
          title={`Copy path: ${buildSqlPath(selectedItem.path)}`}
          aria-label="Copy selected path"
        >
          📋
        </button>
      )}

      <span className="dremio-toolbar-spacer" />

      <button
        className="dremio-toolbar-btn"
        onClick={onCreateFolder}
        disabled={!canCreateFolder}
        title={canCreateFolder ? `New folder inside "${selectedItem!.path[selectedItem!.path.length - 1]}"` : 'Select a folder or space first'}
        aria-label="New folder"
      >
        <IconFolderPlus />
      </button>

      <button
        className="dremio-toolbar-btn dremio-toolbar-btn--logout"
        onClick={onLogout}
        title={`Disconnect from ${creds.url}`}
        aria-label="Log out"
      >
        <IconSignOut />
      </button>
    </div>
  );
}
