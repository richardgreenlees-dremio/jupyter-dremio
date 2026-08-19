import * as React from 'react';
import { useState, useEffect, useRef, KeyboardEvent } from 'react';
import * as ReactDOM from 'react-dom';
import { DremioCredentials, CatalogItem, fetchTags, saveTags } from '../api';

const SUGGESTED_TAGS = ['public', 'indicator', 'reference', 'viewer', 'restapi'];

interface Props {
  item: CatalogItem;
  creds: DremioCredentials;
  onClose: () => void;
}

export function TagEditor({ item, creds, onClose }: Props): JSX.Element {
  const name = item.path[item.path.length - 1] ?? item.id;
  const inputRef = useRef<HTMLInputElement>(null);

  const [tags, setTags] = useState<string[]>([]);
  const [version, setVersion] = useState<string | undefined>(undefined);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchTags(creds, item.id)
      .then(data => {
        setTags(data.tags);
        setVersion(data.version);
      })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addTag = (tag: string) => {
    const trimmed = tag.trim().toLowerCase();
    if (!trimmed) return;
    setTags(prev => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
  };

  const removeTag = (tag: string) => {
    setTags(prev => prev.filter(t => t !== tag));
  };

  const toggleSuggested = (tag: string) => {
    if (tags.includes(tag)) {
      removeTag(tag);
    } else {
      addTag(tag);
    }
  };

  const commitInput = () => {
    inputValue.split(/[\s,]+/).forEach(t => addTag(t));
    setInputValue('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === ',') {
      e.preventDefault();
      commitInput();
    } else if (e.key === 'Backspace' && inputValue === '' && tags.length > 0) {
      setTags(prev => prev.slice(0, -1));
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  const handleSave = async () => {
    commitInput();
    setSaving(true);
    setError(null);
    try {
      const updated = await saveTags(creds, item.id, tags, version);
      setVersion(updated.version);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return ReactDOM.createPortal(
    <div className="dremio-tag-overlay" onClick={handleOverlayClick}>
      <div className="dremio-tag-dialog">
        <div className="dremio-tag-header">
          <span className="dremio-tag-title">Edit Tags</span>
          <span className="dremio-tag-subtitle" title={item.path.join('/')}>
            {name}
          </span>
          <button className="dremio-tag-close" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        <div className="dremio-tag-body">
          {loading && <div className="dremio-tag-loading">Loading…</div>}
          {error && <div className="dremio-tag-error">{error}</div>}

          {!loading && (
            <>
              <div className="dremio-tag-section-label">Suggested</div>
              <div className="dremio-tag-suggestions">
                {SUGGESTED_TAGS.map(t => (
                  <button
                    key={t}
                    className={`dremio-tag-suggestion${tags.includes(t) ? ' dremio-tag-suggestion--active' : ''}`}
                    onClick={() => toggleSuggested(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>

              <div className="dremio-tag-section-label">Tags</div>
              <div
                className="dremio-tag-input-area"
                onClick={() => inputRef.current?.focus()}
              >
                {tags.map(t => (
                  <span key={t} className="dremio-tag-chip">
                    {t}
                    <button
                      className="dremio-tag-chip-remove"
                      onClick={e => { e.stopPropagation(); removeTag(t); }}
                      title={`Remove "${t}"`}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  ref={inputRef}
                  className="dremio-tag-text-input"
                  placeholder={tags.length === 0 ? 'Type a tag, press Space or Enter…' : ''}
                  value={inputValue}
                  onChange={e => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={commitInput}
                  disabled={saving}
                  autoFocus
                />
              </div>
              <div className="dremio-tag-hint">
                Space, comma, or Enter adds a tag. Backspace removes the last one.
              </div>
            </>
          )}
        </div>

        <div className="dremio-tag-footer">
          <button className="dremio-tag-btn dremio-tag-btn--secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            className="dremio-tag-btn dremio-tag-btn--primary"
            onClick={() => { void handleSave(); }}
            disabled={loading || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
