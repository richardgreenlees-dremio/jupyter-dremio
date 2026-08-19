import * as React from 'react';
import { CatalogItemKind } from '../api';

interface Props {
  kind: CatalogItemKind;
}

const SVG_PROPS = {
  viewBox: '0 0 16 16',
  width: 14,
  height: 14,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

function FolderIcon({ formatted = false }: { formatted?: boolean }): JSX.Element {
  return (
    <svg {...SVG_PROPS}>
      <path d="M1.5 4.5h5l1.4 1.7h6.6v6.8c0 .6-.4 1-1 1h-11c-.6 0-1-.4-1-1V5.5c0-.6.4-1 1-1Z" />
      {formatted && <path d="M4.2 8.5h7.1M4.2 10.8h7.1" />}
    </svg>
  );
}

function TableIcon(): JSX.Element {
  return (
    <svg {...SVG_PROPS}>
      <rect x="1.5" y="2" width="13" height="12" rx="1" />
      <path d="M1.5 5.5h13M5.5 2v12M10.5 5.5V14M1.5 9.8h13" />
    </svg>
  );
}

/** Dremio-style catalog glyphs: source, namespace, table, view, and file. */
export function CatalogItemIcon({ kind }: Props): JSX.Element {
  switch (kind) {
    case 'catalog':
      return (
        <svg {...SVG_PROPS}>
          <path d="m8 1.5 5 2.8v7.4L8 14.5l-5-2.8V4.3L8 1.5Z" />
          <path d="m3 4.3 5 2.8 5-2.8M8 7.1v7.4" />
        </svg>
      );
    case 'home':
      return (
        <svg {...SVG_PROPS}>
          <path d="m2 7 6-5 6 5v6.5H9.5v-4h-3v4H2V7Z" />
        </svg>
      );
    case 'space':
      return (
        <svg {...SVG_PROPS}>
          <rect x="2" y="2" width="12" height="12" rx="2" />
          <path d="M5 5h6M5 8h6M5 11h3" />
        </svg>
      );
    case 'folder':
    case 'source-folder':
      return <FolderIcon />;
    case 'formatted-source-folder':
      return <FolderIcon formatted />;
    case 'pds':
    case 'formatted-source-file':
      return <TableIcon />;
    case 'vds':
      return (
        <svg {...SVG_PROPS}>
          <path d="M1.5 8s2.3-4 6.5-4 6.5 4 6.5 4-2.3 4-6.5 4-6.5-4-6.5-4Z" />
          <circle cx="8" cy="8" r="1.7" />
        </svg>
      );
    case 'source':
      return (
        <svg {...SVG_PROPS}>
          <ellipse cx="8" cy="3.4" rx="5.5" ry="1.9" />
          <path d="M2.5 3.4v5.1c0 1 2.5 1.9 5.5 1.9s5.5-.9 5.5-1.9V3.4M2.5 8.5v4.1c0 1 2.5 1.9 5.5 1.9s5.5-.9 5.5-1.9V8.5" />
        </svg>
      );
    case 'source-file':
      return (
        <svg {...SVG_PROPS}>
          <path d="M4 1.5h5l3 3V14H4V1.5Z" />
          <path d="M9 1.5v3h3M6 8h4M6 10.5h4" />
        </svg>
      );
  }
}
