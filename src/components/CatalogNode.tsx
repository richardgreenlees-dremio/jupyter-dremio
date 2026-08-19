import * as React from 'react';
import { useState, useCallback, useEffect } from 'react';
import {
  DremioCredentials,
  CatalogItem,
  ColumnField,
  fetchCatalogItem,
  deleteCatalogItem,
  isContainer,
  isDataset,
  isFile,
  buildSqlPath,
  CatalogItemKind,
  resolvedCatalogItemKind,
  catalogDeleteLabel,
} from '../api';
import { ContextMenu } from './ContextMenu';
import { TagEditor } from './TagEditor';
import { RegisterDatasetDialog } from './RegisterDatasetDialog';
import { CatalogItemIcon } from './CatalogItemIcon';

interface Props {
  item: CatalogItem;
  creds: DremioCredentials;
  depth: number;
  selected: string | null;
  onSelect: (item: CatalogItem) => void;
  onOpenWiki: (item: CatalogItem) => void;
  onDeleteItem: (id: string) => void;
  onCatalogChanged: () => Promise<void>;
  catalogRevision: number;
  expanded: boolean;
  expandedIds: ReadonlySet<string>;
  onExpandedChange: (id: string, expanded: boolean) => void;
  parentKind?: CatalogItemKind;
}

const TYPE_BADGE: Record<string, string> = {
  VARCHAR: 'abc', NVARCHAR: 'abc', CHAR: 'abc', TEXT: 'abc',
  INTEGER: '123', INT: '123', BIGINT: '123', SMALLINT: '123', TINYINT: '123',
  FLOAT: '1.5', DOUBLE: '1.5', DECIMAL: '1.5', NUMERIC: '1.5',
  BOOLEAN: 'T/F', BIT: 'T/F',
  DATE: 'dt', TIME: 'dt',
  TIMESTAMP: 'ts', DATETIME: 'ts',
  BINARY: 'bin', VARBINARY: 'bin',
};

function typeBadge(typeName: string): string {
  return TYPE_BADGE[typeName.toUpperCase()] ?? typeName.toLowerCase().slice(0, 3);
}

export function CatalogNode({
  item,
  creds,
  depth,
  selected,
  onSelect,
  onOpenWiki,
  onDeleteItem,
  onCatalogChanged,
  catalogRevision,
  expanded,
  expandedIds,
  onExpandedChange,
  parentKind,
}: Props): JSX.Element {
  const [children, setChildren] = useState<CatalogItem[]>([]);
  const [fields, setFields] = useState<ColumnField[]>([]);
  // Sub-type resolved from the full-detail fetch (may not be in listing items)
  const [detailType, setDetailType] = useState<string | null>(null);
  const [detailItem, setDetailItem] = useState<CatalogItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showTagEditor, setShowTagEditor] = useState(false);
  const [showRegisterDataset, setShowRegisterDataset] = useState(false);
  const [registerFormat, setRegisterFormat] = useState<'Text (Delimited)' | 'JSON' | 'Parquet' | 'Excel' | 'Iceberg' | undefined>(undefined);

  const displayName = item.path[item.path.length - 1] ?? item.id;
  const kind = resolvedCatalogItemKind(item, detailItem, parentKind);
  const container = isContainer(item);
  const dataset = isDataset(item);
  const file = isFile(item);
  const folder = item.containerType === 'FOLDER' || item.type === 'FOLDER' || detailType === 'FOLDER';
  const expandable = container || dataset;
  const isSelected = selected === item.id;
  const sqlPath = buildSqlPath(item.path);

  const loadChildren = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const detail = await fetchCatalogItem(creds, item.id);
      setDetailItem(detail);
      // Capture the specific sub-type from the full detail response so the
      // delete label can be resolved even when the listing item only carries
      // the generic "DATASET" / "CONTAINER" type.
      const resolved = detail.datasetType ?? detail.containerType ?? detail.type ?? null;
      if (resolved) setDetailType(resolved as string);
      if (dataset) {
        setFields(detail.fields ?? []);
      } else {
        setChildren(detail.children ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [creds, item.id, dataset]);

  useEffect(() => {
    if (catalogRevision > 0 && expanded) {
      void loadChildren();
    }
  }, [catalogRevision, expanded, loadChildren]);

  const handleToggle = async () => {
    if (!expandable) return;
    const needsLoad = dataset ? fields.length === 0 : children.length === 0;
    if (!expanded && needsLoad) {
      await loadChildren();
    }
    onExpandedChange(item.id, !expanded);
  };

  const handleRefresh = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await loadChildren();
    onExpandedChange(item.id, true);
  };

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onSelect(item);
    void handleToggle();
  };

  const handleDragStart = (e: React.DragEvent) => {
    let text: string;
    if (dataset) {
      // Quote the alias so names with spaces, reserved words, or special
      // characters work in all cases. Escape any embedded double-quotes.
      const alias = `"${displayName.replace(/"/g, '""')}"`;
      const cols = fields.length > 0
        ? fields.map(f => `    "${f.name}"`).join(',\n')
        : '    *';
      text =
        `SELECT\n${cols}\nFROM ${sqlPath} AS ${alias}\nLIMIT 100`;
    } else {
      text = sqlPath;
    }
    e.dataTransfer.setData('text/plain', text);
    e.dataTransfer.effectAllowed = 'copy';
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const copyPathToClipboard = () => {
    void navigator.clipboard.writeText(sqlPath);
  };

  const deleteLabel = catalogDeleteLabel(item, detailType);

  const handleDelete = async () => {
    if (!deleteLabel) return;
    if (!window.confirm(`${deleteLabel} "${displayName}"? This cannot be undone.`)) return;
    try {
      await deleteCatalogItem(creds, item.id);
      onDeleteItem(item.id);
      await onCatalogChanged();
    } catch (e) {
      alert(`Delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleRegisterDataset = async () => {
    if (folder) {
      try {
        const detail = await fetchCatalogItem(creds, item.id);
        const names = (detail.children ?? []).map(child => child.path[child.path.length - 1]?.toLowerCase() ?? '');
        if (names.includes('metadata')) setRegisterFormat('Iceberg');
        else if (names.some(name => name.endsWith('.parquet'))) setRegisterFormat('Parquet');
        else if (names.some(name => name.endsWith('.json'))) setRegisterFormat('JSON');
        else if (names.some(name => name.endsWith('.xlsx') || name.endsWith('.xls'))) setRegisterFormat('Excel');
        else setRegisterFormat('Text (Delimited)');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    } else {
      setRegisterFormat(undefined);
    }
    setShowRegisterDataset(true);
  };

  return (
    <div className={`dremio-node${isSelected ? ' dremio-node--selected' : ''}`}>
      <div
        className="dremio-node-row"
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={handleDragStart}
        title={dataset ? `Drag to insert SELECT statement` : `Drag to insert: ${sqlPath}`}
      >
        {expandable && (
          <span className={`dremio-chevron${expanded ? ' dremio-chevron--open' : ''}`}>
            ›
          </span>
        )}
        {!expandable && <span className="dremio-chevron dremio-chevron--leaf" />}
        <span className="dremio-node-icon">
          <CatalogItemIcon kind={kind} />
        </span>
        <span className="dremio-node-label">{displayName}</span>
        {container && (
          <button className="dremio-refresh-btn" onClick={handleRefresh} title="Refresh">
            ↺
          </button>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              icon: '📄',
              label: 'Open wiki',
              onClick: () => onOpenWiki(item),
            },
            {
              icon: '📋',
              label: 'Copy path to clipboard',
              onClick: copyPathToClipboard,
            },
            {
              icon: '🏷️',
              label: 'Edit tags',
              onClick: () => setShowTagEditor(true),
            },
            ...(file || folder ? [{
              icon: '🗂️',
              label: 'Register as Dataset',
              onClick: () => { void handleRegisterDataset(); },
              separator: true,
            }] : []),
            ...(deleteLabel ? [{
              icon: '🗑️',
              label: deleteLabel,
              onClick: () => { void handleDelete(); },
              separator: !(file || folder),
              danger: true,
            }] : []),
          ]}
        />
      )}

      {showTagEditor && (
        <TagEditor item={item} creds={creds} onClose={() => setShowTagEditor(false)} />
      )}
      {showRegisterDataset && (
        <RegisterDatasetDialog item={item} creds={creds} isFolder={folder} initialFormat={registerFormat} onPromoted={onCatalogChanged} onClose={() => setShowRegisterDataset(false)} />
      )}

      {error && (
        <div className="dremio-node-error" style={{ paddingLeft: `${depth * 14 + 24}px` }}>
          {error}
        </div>
      )}
      {loading && (
        <div className="dremio-node-loading" style={{ paddingLeft: `${depth * 14 + 24}px` }}>
          Loading…
        </div>
      )}

      {expanded && dataset && fields.length > 0 && (
        <div className="dremio-node-fields">
          {fields.map(f => (
            <div
              key={f.name}
              className="dremio-field-row"
              style={{ paddingLeft: `${(depth + 1) * 14 + 6}px` }}
            >
              <span className="dremio-field-name">{f.name}</span>
              <span className={`dremio-field-badge dremio-field-badge--${typeBadge(f.type.name)}`}>
                {typeBadge(f.type.name)}
              </span>
            </div>
          ))}
        </div>
      )}

      {expanded && dataset && !loading && fields.length === 0 && !error && (
        <div className="dremio-node-empty" style={{ paddingLeft: `${depth * 14 + 24}px` }}>
          No columns
        </div>
      )}

      {expanded && container && children.length > 0 && (
        <div className="dremio-node-children">
          {children.map(child => (
            <CatalogNode
              key={child.id}
              item={child}
              creds={creds}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              onOpenWiki={onOpenWiki}
              onDeleteItem={id => setChildren(prev => prev.filter(c => c.id !== id))}
              onCatalogChanged={onCatalogChanged}
              catalogRevision={catalogRevision}
              expanded={expandedIds.has(child.id)}
              expandedIds={expandedIds}
              onExpandedChange={onExpandedChange}
              parentKind={kind}
            />
          ))}
        </div>
      )}
      {expanded && container && !loading && children.length === 0 && !error && (
        <div className="dremio-node-empty" style={{ paddingLeft: `${depth * 14 + 24}px` }}>
          Empty
        </div>
      )}
    </div>
  );
}
