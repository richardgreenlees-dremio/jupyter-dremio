import * as React from 'react';
import { useEffect, useState } from 'react';
import { DremioCredentials, saveWiki } from '../api';

interface Props {
  title: string;
  markdown: string;
  itemId: string;
  version?: number;
  creds: DremioCredentials | null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inlineMarkdown(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );
}

function markdownToHtml(md: string): string {
  if (!md.trim()) {
    return '<p><em>No wiki content available for this item.</em></p>';
  }

  let html = '';
  let inCodeBlock = false;
  let inList = false;
  let listTag = 'ul';

  const closeList = () => {
    if (inList) {
      html += `</${listTag}>\n`;
      inList = false;
    }
  };

  for (const line of md.split('\n')) {
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      if (inCodeBlock) {
        html += '</code></pre>\n';
        inCodeBlock = false;
      } else {
        closeList();
        const lang = fenceMatch[1];
        html += `<pre><code${lang ? ` class="language-${lang}"` : ''}>`;
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      html += escapeHtml(line) + '\n';
      continue;
    }

    let m: RegExpMatchArray | null;

    if ((m = line.match(/^(#{1,6})\s+(.+)/))) {
      closeList();
      const level = m[1].length;
      html += `<h${level}>${inlineMarkdown(m[2])}</h${level}>\n`;
      continue;
    }

    if (/^[-*_]{3,}$/.test(line.trim())) {
      closeList();
      html += '<hr>\n';
      continue;
    }

    if ((m = line.match(/^[-*+]\s+(.*)/))) {
      if (!inList || listTag !== 'ul') { closeList(); html += '<ul>\n'; inList = true; listTag = 'ul'; }
      html += `<li>${inlineMarkdown(m[1])}</li>\n`;
      continue;
    }

    if ((m = line.match(/^\d+\.\s+(.*)/))) {
      if (!inList || listTag !== 'ol') { closeList(); html += '<ol>\n'; inList = true; listTag = 'ol'; }
      html += `<li>${inlineMarkdown(m[1])}</li>\n`;
      continue;
    }

    if ((m = line.match(/^>\s*(.*)/))) {
      closeList();
      html += `<blockquote><p>${inlineMarkdown(m[1])}</p></blockquote>\n`;
      continue;
    }

    if (line.trim() === '') {
      closeList();
      html += '\n';
      continue;
    }

    closeList();
    html += `<p>${inlineMarkdown(line)}</p>\n`;
  }

  if (inCodeBlock) html += '</code></pre>\n';
  if (inList) html += `</${listTag}>\n`;

  return html;
}

export function WikiViewer({ title, markdown, itemId, version, creds }: Props): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(markdown);
  const [savedMarkdown, setSavedMarkdown] = useState(markdown);
  const [savedVersion, setSavedVersion] = useState(version);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setEditing(false);
    setDraft(markdown);
    setSavedMarkdown(markdown);
    setSavedVersion(version);
    setError(null);
  }, [itemId, markdown, version]);

  const startEdit = () => {
    setDraft(savedMarkdown);
    setError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    setDraft(savedMarkdown);
    setError(null);
    setEditing(false);
  };

  const submitEdit = async () => {
    if (!creds) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveWiki(creds, itemId, draft, savedVersion);
      setSavedMarkdown(saved.text ?? draft);
      setSavedVersion(saved.version);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dremio-wiki">
      <div className="dremio-wiki-header">
        <span className="dremio-wiki-icon">📄</span>
        <span className="dremio-wiki-title">{title || 'Wiki'}</span>
        {!editing && (
          <button className="dremio-wiki-edit-btn" onClick={startEdit} title="Edit wiki" aria-label="Edit wiki">
            ✏️
          </button>
        )}
      </div>
      {editing ? (
        <div className="dremio-wiki-editor">
          <textarea
            className="dremio-wiki-textarea"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            disabled={saving}
            aria-label="Wiki Markdown"
          />
          {error && <div className="dremio-wiki-error">{error}</div>}
          <div className="dremio-wiki-editor-actions">
            <button className="dremio-tag-btn dremio-tag-btn--secondary" onClick={cancelEdit} disabled={saving}>Cancel</button>
            <button className="dremio-tag-btn dremio-tag-btn--primary" onClick={() => { void submitEdit(); }} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : (
        <div
          className="dremio-wiki-content"
          dangerouslySetInnerHTML={{ __html: markdownToHtml(savedMarkdown) }}
        />
      )}
    </div>
  );
}
