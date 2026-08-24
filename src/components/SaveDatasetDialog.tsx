import * as React from 'react';
import { useEffect, useState } from 'react';
import * as ReactDOM from 'react-dom';
import {
  canWriteCatalogItem,
  CatalogItem,
  DremioCredentials,
  fetchCatalogItem,
  fetchRootCatalog,
  findCatalogItemByPath,
  catalogItemKind,
} from '../api';
import { CatalogItemIcon } from './CatalogItemIcon';

export type SaveTargetKind = 'view' | 'table';
export type TableWriteMode = 'copy-on-write' | 'merge-on-read';
export type PartitionTransform = 'identity' | 'year' | 'month' | 'day' | 'hour' | 'bucket' | 'truncate';

export interface PartitionSetting {
  column: string;
  transform: PartitionTransform;
  argument: string;
}

export interface SaveDatasetRequest {
  title: string;
  allowedKinds: SaveTargetKind[];
  initialKind: SaveTargetKind;
}

export interface SaveDatasetSubmission {
  kind: SaveTargetKind;
  destination: CatalogItem;
  name: string;
  partitions: PartitionSetting[];
  writeMode: TableWriteMode;
}

interface Props {
  creds: DremioCredentials;
  request: SaveDatasetRequest;
  onSubmit: (submission: SaveDatasetSubmission) => Promise<void>;
  onClose: () => void;
}

interface DestinationNodeProps {
  item: CatalogItem;
  creds: DremioCredentials;
  depth: number;
  selectedId: string | null;
  onSelect: (item: CatalogItem) => void;
}

function isOpenCatalogRoot(item: CatalogItem): boolean {
  return item.containerType === 'SOURCE' &&
    (item.openCatalog === true || catalogItemKind(item) === 'catalog');
}

async function loadWritableChildren(creds: DremioCredentials, item: CatalogItem): Promise<CatalogItem[]> {
  const detail = await fetchCatalogItem(creds, item.id, true);
  const inOpenCatalog = item.openCatalog === true || isOpenCatalogRoot(item);
  const children = await Promise.all((detail.children ?? []).map(async child => {
    try {
      // Permissions are attached to the item detail, not consistently to a
      // parent's children array. Resolve each child before filtering it.
      const childDetail = await fetchCatalogItem(creds, child.id, true);
      return {
        ...child,
        permissions: childDetail.permissions ?? child.permissions,
        openCatalog: inOpenCatalog,
      };
    } catch {
      return { ...child, openCatalog: inOpenCatalog };
    }
  }));
  return children.filter(canWriteCatalogItem);
}

function DestinationNode({ item, creds, depth, selectedId, onSelect }: DestinationNodeProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<CatalogItem[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!expanded && children === null) {
      setLoading(true);
      try {
        setChildren(await loadWritableChildren(creds, item));
      } catch {
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
    setExpanded(value => !value);
  };

  const displayName = item.path[item.path.length - 1] ?? item.id;
  const kind = item.containerType === 'SPACE' ? 'space' : item.containerType === 'SOURCE' ? 'source' : 'folder';
  const selectable = !isOpenCatalogRoot(item);

  return (
    <div className="dremio-save-tree-node">
      <div className={`dremio-save-tree-row${selectedId === item.id ? ' dremio-save-tree-row--selected' : ''}`} style={{ paddingLeft: `${depth * 14 + 6}px` }}>
        <button className="dremio-save-tree-toggle" onClick={toggle} title="Show child locations" aria-label={`Show locations inside ${displayName}`}>
          {loading ? '…' : expanded ? '⌄' : '›'}
        </button>
        <button className="dremio-save-tree-select" onClick={() => onSelect(item)} disabled={!selectable} title={selectable ? undefined : 'Choose a namespace inside Open Catalog'}>
          <span className="dremio-node-icon"><CatalogItemIcon kind={kind} /></span>
          {displayName}
        </button>
      </div>
      {expanded && children?.map(child => (
        <DestinationNode
          key={child.id}
          item={child}
          creds={creds}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
      {expanded && children?.length === 0 && <div className="dremio-save-tree-empty">No writable child locations</div>}
    </div>
  );
}

function validName(name: string): string | null {
  if (!name.trim()) return 'Enter a table or view name.';
  if (/[/:\[\]]/.test(name)) return 'Names cannot contain /, :, [, or ].';
  return null;
}

function PartitionEditor({ partitions, onChange }: {
  partitions: PartitionSetting[];
  onChange: (partitions: PartitionSetting[]) => void;
}): JSX.Element {
  const update = (index: number, changes: Partial<PartitionSetting>) => {
    onChange(partitions.map((partition, current) => current === index ? { ...partition, ...changes } : partition));
  };

  return (
    <div className="dremio-save-partitions">
      <div className="dremio-tag-section-label">Partitioning</div>
      {partitions.map((partition, index) => (
        <div className="dremio-save-partition-row" key={index}>
          <input
            className="dremio-save-input"
            aria-label="Partition column"
            placeholder="Column"
            value={partition.column}
            onChange={event => update(index, { column: event.target.value })}
          />
          <select className="dremio-save-select" value={partition.transform} onChange={event => update(index, { transform: event.target.value as PartitionTransform, argument: '' })}>
            <option value="identity">Identity</option>
            <option value="year">Year</option>
            <option value="month">Month</option>
            <option value="day">Day</option>
            <option value="hour">Hour</option>
            <option value="bucket">Bucket</option>
            <option value="truncate">Truncate</option>
          </select>
          {(partition.transform === 'bucket' || partition.transform === 'truncate') && (
            <input
              className="dremio-save-partition-argument"
              aria-label={`${partition.transform} size`}
              placeholder="Size"
              value={partition.argument}
              onChange={event => update(index, { argument: event.target.value })}
            />
          )}
          <button className="dremio-save-icon-button" onClick={() => onChange(partitions.filter((_, current) => current !== index))} title="Remove partition">×</button>
        </div>
      ))}
      <button className="dremio-save-add-partition" onClick={() => onChange([...partitions, { column: '', transform: 'identity', argument: '' }])}>+ Add partition</button>
    </div>
  );
}

export function SaveDatasetDialog({ creds, request, onSubmit, onClose }: Props): JSX.Element {
  const [kind, setKind] = useState<SaveTargetKind>(request.initialKind);
  const [locations, setLocations] = useState<CatalogItem[]>([]);
  const [locationsError, setLocationsError] = useState<string | null>(null);
  const [loadingLocations, setLoadingLocations] = useState(true);
  const [destination, setDestination] = useState<CatalogItem | null>(null);
  const [name, setName] = useState('');
  const [partitions, setPartitions] = useState<PartitionSetting[]>([]);
  const [writeMode, setWriteMode] = useState<TableWriteMode>('copy-on-write');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    fetchRootCatalog(creds, true)
      .then(async root => {
        const locations = await Promise.all((root.data ?? []).map(async item => {
          if (item.containerType !== 'SOURCE') return item;
          try {
            const detail = await fetchCatalogItem(creds, item.id, true);
            const source = {
              ...item,
              permissions: detail.permissions ?? item.permissions,
              sourceType: detail.sourceType ?? (typeof detail.type === 'string' ? detail.type : undefined),
              isPrimaryCatalog: detail.isPrimaryCatalog,
            };
            return { ...source, openCatalog: catalogItemKind(source) === 'catalog' };
          } catch {
            return item;
          }
        }));
        if (active) setLocations(locations.filter(canWriteCatalogItem));
      })
      .catch(reason => {
        if (active) setLocationsError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoadingLocations(false);
      });
    return () => { active = false; };
  }, [creds]);

  const handleSubmit = async () => {
    const nameError = validName(name);
    if (nameError) {
      setError(nameError);
      return;
    }
    if (!destination) {
      setError('Choose a writable destination.');
      return;
    }
    const incompletePartition = partitions.find(partition =>
      !partition.column.trim() ||
      ((partition.transform === 'bucket' || partition.transform === 'truncate') && !/^\d+$/.test(partition.argument))
    );
    if (kind === 'table' && incompletePartition) {
      setError('Each partition needs a column; bucket and truncate also need a numeric size.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const existing = destination.openCatalog
        ? (await fetchCatalogItem(creds, destination.id, true)).children?.find(
          child => child.path[child.path.length - 1] === name.trim()
        ) ?? null
        : await findCatalogItemByPath(creds, [...destination.path, name.trim()]);
      if (existing) {
        setError(`A catalog object named “${name.trim()}” already exists in this location.`);
        return;
      }
      await onSubmit({ kind, destination, name: name.trim(), partitions, writeMode });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return ReactDOM.createPortal(
    <div className="dremio-tag-overlay" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="dremio-tag-dialog dremio-save-dialog" role="dialog" aria-modal="true" aria-label={request.title}>
        <div className="dremio-tag-header">
          <span className="dremio-tag-title">{request.title}</span>
          <button className="dremio-tag-close" onClick={onClose} title="Close" disabled={submitting}>×</button>
        </div>
        <div className="dremio-tag-body">
          {request.allowedKinds.length > 1 && (
            <label className="dremio-save-field">
              <span className="dremio-tag-section-label">Save as</span>
              <select className="dremio-save-select" value={kind} onChange={event => setKind(event.target.value as SaveTargetKind)}>
                <option value="view">Virtual dataset (VDS)</option>
                <option value="table">Table</option>
              </select>
            </label>
          )}
          <label className="dremio-save-field">
            <span className="dremio-tag-section-label">Name</span>
            <input className="dremio-save-input" value={name} onChange={event => setName(event.target.value)} autoFocus />
          </label>
          <div className="dremio-save-field">
            <span className="dremio-tag-section-label">Save location</span>
            <div className="dremio-save-tree">
              {loadingLocations && <div className="dremio-save-tree-empty">Loading writable locations…</div>}
              {locationsError && <div className="dremio-tag-error">Could not load writable locations: {locationsError}</div>}
              {!loadingLocations && !locationsError && locations.length === 0 && <div className="dremio-save-tree-empty">No writable locations are available.</div>}
              {locations.map(item => <DestinationNode key={item.id} item={item} creds={creds} depth={0} selectedId={destination?.id ?? null} onSelect={item => { setDestination(item); setError(null); }} />)}
            </div>
          </div>
          {kind === 'table' && (
            <>
              <PartitionEditor partitions={partitions} onChange={setPartitions} />
              <label className="dremio-save-field">
                <span className="dremio-tag-section-label">Table write mode</span>
                <select className="dremio-save-select" value={writeMode} onChange={event => setWriteMode(event.target.value as TableWriteMode)}>
                  <option value="copy-on-write">Copy-on-write</option>
                  <option value="merge-on-read">Merge-on-read</option>
                </select>
              </label>
            </>
          )}
          {error && <div className="dremio-tag-error">{error}</div>}
        </div>
        <div className="dremio-tag-footer">
          <button className="dremio-tag-btn dremio-tag-btn--secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="dremio-tag-btn dremio-tag-btn--primary" onClick={() => { void handleSubmit(); }} disabled={submitting || loadingLocations}>
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
