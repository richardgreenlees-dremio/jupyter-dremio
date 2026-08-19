import * as React from 'react';
import { useState } from 'react';
import * as ReactDOM from 'react-dom';
import {
  CatalogItem,
  DremioCredentials,
  promoteToExcelDataset,
  promoteToIcebergDataset,
  promoteToJsonDataset,
  promoteToParquetDataset,
  promoteToTextDataset,
} from '../api';

const FORMAT_OPTIONS = ['Text (Delimited)', 'JSON', 'Parquet', 'Excel', 'Iceberg'] as const;
const COLUMN_DELIMITERS = ['Comma', 'Tab', 'Pipe', 'Custom...'] as const;
const LINE_DELIMITERS = ['CRLF - Windows', 'LF - Unix/Linux', 'Custom...'] as const;
const QUOTES = ['Double Quote', 'Single Quote', 'Custom...'] as const;
const ESCAPES = ['Double Quote', 'Back Quote', 'Backslash', 'Custom...'] as const;
type DatasetFormat = typeof FORMAT_OPTIONS[number];

interface Props {
  item: CatalogItem;
  creds: DremioCredentials;
  isFolder?: boolean;
  initialFormat?: DatasetFormat;
  onPromoted: () => Promise<void>;
  onClose: () => void;
}

function formatForFile(item: CatalogItem): typeof FORMAT_OPTIONS[number] {
  const name = item.path[item.path.length - 1] ?? '';
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (extension === '.csv' || extension === '.tsv') return 'Text (Delimited)';
  if (extension === '.json') return 'JSON';
  if (extension === '.parquet') return 'Parquet';
  if (extension === '.xls' || extension === '.xlsx') return 'Excel';
  return 'Text (Delimited)';
}

function columnDelimiterForFile(item: CatalogItem): typeof COLUMN_DELIMITERS[number] {
  const name = item.path[item.path.length - 1] ?? '';
  return name.toLowerCase().endsWith('.tsv') ? 'Tab' : 'Comma';
}

function parseDelimiter(value: string): string {
  return value.replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

function DelimiterSetting({
  label,
  options,
  selected,
  value,
  onSelect,
  onValueChange,
}: {
  label: string;
  options: readonly string[];
  selected: string;
  value: string;
  onSelect: (selected: string) => void;
  onValueChange: (value: string) => void;
}): JSX.Element {
  return (
    <label className="dremio-register-setting">
      <span className="dremio-register-setting-label">{label}</span>
      <span className="dremio-register-setting-inputs">
        <select value={selected} onChange={e => onSelect(e.target.value)}>
          {options.map(option => <option key={option}>{option}</option>)}
        </select>
        <input
          aria-label={`${label} custom value`}
          className="dremio-register-custom-value"
          value={value}
          onChange={e => onValueChange(e.target.value)}
          disabled={selected !== 'Custom...'}
        />
      </span>
    </label>
  );
}

export function RegisterDatasetDialog({ item, creds, isFolder = false, initialFormat, onPromoted, onClose }: Props): JSX.Element {
  const name = item.path[item.path.length - 1] ?? item.id;
  const [format, setFormat] = useState<DatasetFormat>(() => initialFormat ?? formatForFile(item));
  const [columnDelimiter, setColumnDelimiter] = useState(() => columnDelimiterForFile(item));
  const [columnDelimiterValue, setColumnDelimiterValue] = useState(
    () => (columnDelimiterForFile(item) === 'Tab' ? '\\t' : ',')
  );
  const [lineDelimiter, setLineDelimiter] = useState<typeof LINE_DELIMITERS[number]>('CRLF - Windows');
  const [lineDelimiterValue, setLineDelimiterValue] = useState('\\r\\n');
  const [quote, setQuote] = useState<typeof QUOTES[number]>('Double Quote');
  const [quoteValue, setQuoteValue] = useState('"');
  const [escape, setEscape] = useState<typeof ESCAPES[number]>('Double Quote');
  const [escapeValue, setEscapeValue] = useState('"');
  const [extractHeader, setExtractHeader] = useState(false);
  const [skipFirstLine, setSkipFirstLine] = useState(false);
  const [trimHeader, setTrimHeader] = useState(true);
  const [sheetName, setSheetName] = useState('');
  const [excelExtractHeader, setExcelExtractHeader] = useState(false);
  const [hasMergedCells, setHasMergedCells] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      if (format === 'Text (Delimited)') {
        await promoteToTextDataset(creds, item, {
          fieldDelimiter: parseDelimiter(columnDelimiterValue),
          lineDelimiter: parseDelimiter(lineDelimiterValue),
          quote: parseDelimiter(quoteValue),
          escape: parseDelimiter(escapeValue),
          extractHeader,
          skipFirstLine,
          trimHeader,
        }, isFolder);
      } else if (format === 'Excel') {
        await promoteToExcelDataset(creds, item, {
          sheetName,
          extractHeader: excelExtractHeader,
          hasMergedCells,
        }, isFolder);
      } else if (format === 'Parquet') {
        await promoteToParquetDataset(creds, item, isFolder);
      } else if (format === 'JSON') {
        await promoteToJsonDataset(creds, item, isFolder);
      } else {
        await promoteToIcebergDataset(creds, item, isFolder);
      }
      await onPromoted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return ReactDOM.createPortal(
    <div className="dremio-tag-overlay" onClick={handleOverlayClick}>
      <div className="dremio-tag-dialog dremio-register-dialog">
        <div className="dremio-tag-header">
          <span className="dremio-tag-title">{isFolder ? 'Register Folder Dataset' : 'Register Dataset'}</span>
          <span className="dremio-tag-subtitle" title={item.path.join('/')}>
            {name}
          </span>
          <button className="dremio-tag-close" onClick={onClose} title="Close">
            ×
          </button>
        </div>

        <div className="dremio-tag-body">
          <select
            className="dremio-register-format"
            aria-label="Dataset format"
            value={format}
            onChange={e => setFormat(e.target.value as typeof FORMAT_OPTIONS[number])}
          >
            {FORMAT_OPTIONS.map(option => <option key={option}>{option}</option>)}
          </select>
          <div className="dremio-register-panel">
            {format === 'Text (Delimited)' && (
              <>
                <DelimiterSetting
                  label="Column Delimiter"
                  options={COLUMN_DELIMITERS}
                  selected={columnDelimiter}
                  value={columnDelimiterValue}
                  onSelect={selected => {
                    setColumnDelimiter(selected as typeof COLUMN_DELIMITERS[number]);
                    if (selected === 'Comma') setColumnDelimiterValue(',');
                    if (selected === 'Tab') setColumnDelimiterValue('\\t');
                    if (selected === 'Pipe') setColumnDelimiterValue('|');
                  }}
                  onValueChange={setColumnDelimiterValue}
                />
                <DelimiterSetting
                  label="Line Delimiter"
                  options={LINE_DELIMITERS}
                  selected={lineDelimiter}
                  value={lineDelimiterValue}
                  onSelect={selected => {
                    setLineDelimiter(selected as typeof LINE_DELIMITERS[number]);
                    if (selected === 'CRLF - Windows') setLineDelimiterValue('\\r\\n');
                    if (selected === 'LF - Unix/Linux') setLineDelimiterValue('\\n');
                  }}
                  onValueChange={setLineDelimiterValue}
                />
                <DelimiterSetting
                  label="Quote"
                  options={QUOTES}
                  selected={quote}
                  value={quoteValue}
                  onSelect={selected => {
                    setQuote(selected as typeof QUOTES[number]);
                    if (selected === 'Double Quote') setQuoteValue('"');
                    if (selected === 'Single Quote') setQuoteValue("'");
                  }}
                  onValueChange={setQuoteValue}
                />
                <DelimiterSetting
                  label="Escape"
                  options={ESCAPES}
                  selected={escape}
                  value={escapeValue}
                  onSelect={selected => {
                    setEscape(selected as typeof ESCAPES[number]);
                    if (selected === 'Double Quote') setEscapeValue('"');
                    if (selected === 'Back Quote') setEscapeValue('`');
                    if (selected === 'Backslash') setEscapeValue('\\');
                  }}
                  onValueChange={setEscapeValue}
                />
                <div className="dremio-register-options">
                  <div className="dremio-tag-section-label">Options</div>
                  <label><input type="checkbox" checked={extractHeader} onChange={e => setExtractHeader(e.target.checked)} /> Extract Column Names</label>
                  <label><input type="checkbox" checked={skipFirstLine} onChange={e => setSkipFirstLine(e.target.checked)} /> Skip First Line</label>
                  <label><input type="checkbox" checked={trimHeader} onChange={e => setTrimHeader(e.target.checked)} /> Trim Column Names</label>
                </div>
              </>
            )}
            {format === 'Excel' && (
              <>
                <label className="dremio-register-setting">
                  <span className="dremio-register-setting-label">Sheet Name</span>
                  <input
                    className="dremio-register-sheet-name"
                    value={sheetName}
                    onChange={e => setSheetName(e.target.value)}
                  />
                </label>
                <div className="dremio-register-options dremio-register-options--excel">
                  <label><input type="checkbox" checked={excelExtractHeader} onChange={e => setExcelExtractHeader(e.target.checked)} /> Extract Column Names</label>
                  <label><input type="checkbox" checked={hasMergedCells} onChange={e => setHasMergedCells(e.target.checked)} /> Expand Merged Cells</label>
                </div>
              </>
            )}
            {error && <div className="dremio-tag-error">Registration failed: {error}</div>}
          </div>
        </div>

        <div className="dremio-tag-footer">
          <button className="dremio-tag-btn dremio-tag-btn--secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className="dremio-tag-btn dremio-tag-btn--primary" onClick={() => { void handleSubmit(); }} disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
