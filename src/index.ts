import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
  ILayoutRestorer,
} from '@jupyterlab/application';
import { ICommandPalette, ToolbarButton, WidgetTracker } from '@jupyterlab/apputils';
import { INotebookTracker, NotebookActions, NotebookPanel } from '@jupyterlab/notebook';
import { Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { dremioIcon } from './icons';
import { DremioPanel } from './components/DremioPanel';
import { WikiWidget } from './WikiWidget';
import { JobsWidget } from './JobsWidget';
import { DremioCredentials, CatalogItem, buildSqlPath, submitSql, fetchFlightAuthorizationHeader } from './api';
import { CellRunTracker, isDremioSqlCell } from './cellJobStatus';
import {
  PartitionSetting,
  SaveDatasetDialog,
  SaveDatasetRequest,
  SaveDatasetSubmission,
} from './components/SaveDatasetDialog';

const PLUGIN_ID = 'jupyter-dremio:plugin';
const PANEL_ID = 'jupyter-dremio:panel';
const COMMAND_OPEN = 'jupyter-dremio:open';
const COMMAND_SAVE = 'jupyter-dremio:save-active-cell';
const SQL_PROVENANCE_KEY = 'jupyter-dremio:dataframe-provenance';

interface SqlProvenance {
  name: string;
  sql: string;
}

type CellJobStatus = 'running' | 'completed' | 'failed';

function renderCellJobStatus(cell: { node: HTMLElement }, status: CellJobStatus): void {
  let element = cell.node.querySelector<HTMLElement>('.dremio-cell-job-status');
  if (!element) {
    element = document.createElement('div');
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    cell.node.appendChild(element);
  }
  element.className = `dremio-cell-job-status dremio-cell-job-status--${status}`;
  const label = status === 'running' ? 'Running' : status === 'completed' ? 'Completed' : 'Failed';
  element.textContent = `Query submitted to Dremio · ${label}`;
}

function extractDremioSql(source: string): string | null {
  const block = source.match(/^\s*%%sql[^\n]*\n([\s\S]*)$/i);
  const inline = source.match(/^\s*[A-Za-z_]\w*\s*=\s*%sql\s+([\s\S]*)$/i);
  const sql = (block?.[1] ?? inline?.[1] ?? '').trim();
  if (!sql) return null;
  // The starter cell may contain USE before the query. It is session context,
  // not part of the query used to define a VDS or CTAS.
  const query = sql.replace(/^(?:USE\s+[^;]+;\s*)+/i, '').trim();
  return /^(SELECT|WITH)\b/i.test(query) ? query : null;
}

function extractSqlProvenance(source: string): SqlProvenance | null {
  const assignment = source.match(/^\s*([A-Za-z_]\w*)\s*=\s*%sql\s+([\s\S]*)$/i);
  if (assignment) {
    const sql = extractDremioSql(source);
    return sql ? { name: assignment[1], sql } : null;
  }
  const saved = source.match(/^\s*%%sql\s+--save\s+([A-Za-z_]\w*)[^\n]*\n([\s\S]*)$/i);
  if (saved) {
    const sql = extractDremioSql(source);
    return sql ? { name: saved[1], sql } : null;
  }
  return null;
}

function dataframeNameFromSource(source: string): string | null {
  const preview = source.match(/^\s*([A-Za-z_]\w*)(?:\.(?:head|tail)\(\))?\s*$/);
  if (preview) return preview[1];
  const assignment = source.match(/^\s*([A-Za-z_]\w*)\s*=/);
  return assignment?.[1] ?? null;
}

function findSqlProvenance(panel: NotebookPanel, dataframeName: string): SqlProvenance | null {
  const model = panel.content.model;
  if (!model) return null;
  for (let index = model.cells.length - 1; index >= 0; index -= 1) {
    const metadata = model.cells.get(index)?.metadata as Record<string, unknown> | undefined;
    const raw = metadata?.[SQL_PROVENANCE_KEY];
    if (typeof raw !== 'object' || raw === null) continue;
    const value = raw as Partial<SqlProvenance>;
    if (value.name === dataframeName && typeof value.sql === 'string') {
      return { name: dataframeName, sql: value.sql };
    }
  }
  return null;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function partitionClause(partitions: PartitionSetting[]): string {
  if (!partitions.length) return '';
  const values = partitions.map(partition => {
    const column = quoteIdentifier(partition.column.trim());
    if (partition.transform === 'identity') return column;
    if (partition.transform === 'bucket' || partition.transform === 'truncate') {
      return `${partition.transform}(${partition.argument}, ${column})`;
    }
    return `${partition.transform}(${column})`;
  });
  return `\nPARTITION BY (${values.join(', ')})`;
}

function tableProperties(mode: SaveDatasetSubmission['writeMode']): string {
  return `\nTBLPROPERTIES (` +
    `'write.delete.mode' = '${mode}', ` +
    `'write.update.mode' = '${mode}', ` +
    `'write.merge.mode' = '${mode}')`;
}

function buildSaveStatement(submission: SaveDatasetSubmission, query: string): string {
  const target = buildSqlPath([...submission.destination.path, submission.name]);
  if (submission.kind === 'view') return `CREATE VIEW ${target} AS\n${query}`;
  return `CREATE TABLE ${target}${partitionClause(submission.partitions)}${tableProperties(submission.writeMode)} AS\n${query}`;
}

function buildSaveCellSource(submission: SaveDatasetSubmission, query: string): string {
  const statement = buildSaveStatement(submission, query);
  return `%%sql\n${statement}`;
}

function buildDataframeWriteCode(submission: SaveDatasetSubmission, dataframeName: string): string {
  const target = buildSqlPath([...submission.destination.path, submission.name]);
  const createTable = `CREATE TABLE ${target} ({{columns}})${partitionClause(submission.partitions)}${tableProperties(submission.writeMode)}`;
  return `import pyarrow as pa\n` +
    `_dremio_frame = ${dataframeName}\n` +
    `if not hasattr(_dremio_frame, "columns"):\n` +
    `    raise TypeError("${dataframeName} is not a pandas DataFrame")\n` +
    `_dremio_arrow = pa.Table.from_pandas(_dremio_frame, preserve_index=False)\n` +
    `def _dremio_type(field):\n` +
    `    t = field.type\n` +
    `    if pa.types.is_boolean(t): return "BOOLEAN"\n` +
    `    if pa.types.is_integer(t): return "BIGINT" if pa.types.is_int64(t) or pa.types.is_uint64(t) else "INTEGER"\n` +
    `    if pa.types.is_floating(t): return "DOUBLE" if pa.types.is_float64(t) else "FLOAT"\n` +
    `    if pa.types.is_decimal(t): return f"DECIMAL({t.precision}, {t.scale})"\n` +
    `    if pa.types.is_date(t): return "DATE"\n` +
    `    if pa.types.is_time(t): return "TIME"\n` +
    `    if pa.types.is_timestamp(t): return "TIMESTAMP"\n` +
    `    if pa.types.is_binary(t): return "VARBINARY"\n` +
    `    if pa.types.is_string(t) or pa.types.is_large_string(t): return "VARCHAR"\n` +
    `    raise TypeError(f"Unsupported DataFrame column type for {field.name}: {t}")\n` +
    `_dremio_columns = ", ".join(f'"{field.name.replace(chr(34), chr(34) * 2)}" {_dremio_type(field)}' for field in _dremio_arrow.schema)\n` +
    `_dremio_ddl = ${JSON.stringify(createTable)}.replace("{{columns}}", _dremio_columns)\n` +
    `with dremio_conn.cursor() as _dremio_cursor:\n` +
    `    _dremio_cursor.execute(_dremio_ddl)\n` +
    `    _dremio_cursor.adbc_ingest(${JSON.stringify(target)}, _dremio_arrow, mode="append")\n`;
}

function insertGeneratedCell(panel: NotebookPanel, source: string): void {
  const model = panel.content.model;
  if (!model) throw new Error('The active notebook is not ready.');
  const insertAt = Math.max(panel.content.activeCellIndex + 1, 0);
  model.sharedModel.insertCell(insertAt, {
    cell_type: 'code',
    source,
    metadata: { 'jupyter-dremio': { generated: true } },
  });
  panel.content.activeCellIndex = insertAt;
}

async function runGeneratedCell(panel: NotebookPanel, source: string): Promise<void> {
  insertGeneratedCell(panel, source);
  const succeeded = await NotebookActions.run(panel.content, panel.sessionContext);
  if (!succeeded) throw new Error('Dremio did not create the object. See the generated cell for details.');
}

async function submitTableStatement(
  panel: NotebookPanel,
  creds: DremioCredentials,
  submission: SaveDatasetSubmission,
  query: string
): Promise<void> {
  const statement = buildSaveStatement(submission, query);
  const job = await submitSql(creds, statement);
  const commentedSql = statement.split('\n').map(line => `# ${line}`).join('\n');
  insertGeneratedCell(
    panel,
    `# Submitted to Dremio as job ${job.id}. Do not re-run this cell.\n${commentedSql}`
  );
}

class DremioWidget extends Widget {
  private _showWiki: (
    name: string,
    markdown: string,
    itemId: string,
    version: number | undefined,
    creds: DremioCredentials
  ) => void;
  private _showJobs: (creds: DremioCredentials) => void;
  private _newNotebook: (creds: DremioCredentials, item: CatalogItem | null) => void;
  private _credentialsChanged: (creds: DremioCredentials | null) => void;

  constructor(
    showWiki: (
      name: string,
      markdown: string,
      itemId: string,
      version: number | undefined,
      creds: DremioCredentials
    ) => void,
    showJobs: (creds: DremioCredentials) => void,
    newNotebook: (creds: DremioCredentials, item: CatalogItem | null) => void,
    credentialsChanged: (creds: DremioCredentials | null) => void
  ) {
    super();
    this._showWiki = showWiki;
    this._showJobs = showJobs;
    this._newNotebook = newNotebook;
    this._credentialsChanged = credentialsChanged;
    this.id = PANEL_ID;
    this.title.icon = dremioIcon;
    this.title.caption = 'Dremio Catalog';
    this.addClass('jp-DremioWidget');
  }

  protected onAfterAttach(_msg: Message): void {
    ReactDOM.render(
      React.createElement(DremioPanel, {
        onShowWiki: this._showWiki,
        onShowJobs: this._showJobs,
        onNewNotebook: this._newNotebook,
        onCredentialsChanged: this._credentialsChanged,
      }),
      this.node
    );
  }

  protected onBeforeDetach(_msg: Message): void {
    ReactDOM.unmountComponentAtNode(this.node);
  }
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Dremio catalog browser for JupyterLab',
  autoStart: true,
  optional: [ICommandPalette, ILayoutRestorer, INotebookTracker],
  activate: (
    app: JupyterFrontEnd,
    palette: ICommandPalette | null,
    restorer: ILayoutRestorer | null,
    nbTracker: INotebookTracker | null
  ) => {
    const tracker = new WidgetTracker<DremioWidget>({ namespace: PANEL_ID });
    const wikiTracker = new WidgetTracker<WikiWidget>({
      namespace: 'jupyter-dremio-wiki',
    });
    const jobsTracker = new WidgetTracker<JobsWidget>({
      namespace: 'jupyter-dremio-jobs',
    });
    const cellRuns = new CellRunTracker();
    let activeCreds: DremioCredentials | null = null;

    const openSaveDialog = (
      panel: NotebookPanel,
      creds: DremioCredentials,
      request: SaveDatasetRequest,
      submit: (submission: SaveDatasetSubmission) => Promise<void>
    ) => {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const close = () => {
        ReactDOM.unmountComponentAtNode(host);
        host.remove();
      };
      ReactDOM.render(
        React.createElement(SaveDatasetDialog, {
          creds,
          request,
          onClose: close,
          onSubmit: submit,
        }),
        host
      );
    };

    const saveActiveCell = (panel: NotebookPanel | null | undefined) => {
      if (!panel) return;
      if (!activeCreds) {
        window.alert('Connect to Dremio from the Dremio Catalog sidebar before saving.');
        return;
      }
      const source = panel.content.activeCell?.model.sharedModel.getSource() ?? '';
      const sql = extractDremioSql(source);
      if (sql) {
        openSaveDialog(
          panel,
          activeCreds,
          { title: 'Save Dremio SQL', allowedKinds: ['view', 'table'], initialKind: 'view' },
          submission => submission.kind === 'table'
            ? submitTableStatement(panel, activeCreds as DremioCredentials, submission, sql)
            : runGeneratedCell(panel, buildSaveCellSource(submission, sql))
        );
        return;
      }

      const dataframeName = dataframeNameFromSource(source);
      if (!dataframeName) {
        window.alert('Select a Dremio SQL cell or a code cell that previews a named pandas DataFrame.');
        return;
      }
      const provenance = findSqlProvenance(panel, dataframeName);
      if (provenance) {
        openSaveDialog(
          panel,
          activeCreds,
          { title: 'Create Table', allowedKinds: ['table'], initialKind: 'table' },
          submission => submitTableStatement(panel, activeCreds as DremioCredentials, submission, provenance.sql)
        );
        return;
      }
      openSaveDialog(
        panel,
        activeCreds,
        { title: 'Write DataFrame as Table', allowedKinds: ['table'], initialKind: 'table' },
        submission => runGeneratedCell(panel, buildDataframeWriteCode(submission, dataframeName))
      );
    };

    app.commands.addCommand(COMMAND_SAVE, {
      label: 'Save to Dremio',
      execute: () => saveActiveCell(nbTracker?.currentWidget),
    });

    const addSaveButton = (panel: NotebookPanel) => {
      if ([...panel.toolbar.names()].includes('dremio-save')) return;
      panel.toolbar.addItem('dremio-save', new ToolbarButton({
        label: 'Save to Dremio',
        tooltip: 'Save the active Dremio SQL result or DataFrame to Dremio',
        onClick: () => saveActiveCell(panel),
      }));
    };

    if (nbTracker) {
      nbTracker.widgetAdded.connect((_sender, panel) => addSaveButton(panel));
      nbTracker.forEach(panel => addSaveButton(panel));
    }

    NotebookActions.executionScheduled.connect((_sender, args) => {
      if (!activeCreds || !isDremioSqlCell(args.cell.model.sharedModel.getSource())) return;
      cellRuns.start(args.cell);
      renderCellJobStatus(args.cell, 'running');
    });

    NotebookActions.executed.connect((_sender, args) => {
      if (cellRuns.finish(args.cell)) {
        renderCellJobStatus(args.cell, args.success ? 'completed' : 'failed');
      }
      if (!args.success) return;
      const provenance = extractSqlProvenance(args.cell.model.sharedModel.getSource());
      if (provenance) args.cell.model.setMetadata(SQL_PROVENANCE_KEY, provenance);
    });

    /** Open or update the singleton wiki panel in the main area. */
    const showWiki = (
      name: string,
      markdown: string,
      itemId: string,
      version: number | undefined,
      creds: DremioCredentials
    ) => {
      let wikiWidget = wikiTracker.find(w => !w.isDisposed);
      if (!wikiWidget) {
        wikiWidget = new WikiWidget();
        void wikiTracker.add(wikiWidget);
      }
      wikiWidget.setContent(name, markdown, itemId, version, creds);
      if (!wikiWidget.isAttached) {
        app.shell.add(wikiWidget, 'main');
      }
      app.shell.activateById(wikiWidget.id);
    };

    /** Open or focus the singleton jobs panel in the main area. */
    const showJobs = (creds: DremioCredentials) => {
      let jobsWidget = jobsTracker.find(w => !w.isDisposed);
      if (!jobsWidget) {
        jobsWidget = new JobsWidget(creds);
        void jobsTracker.add(jobsWidget);
      } else {
        jobsWidget.updateCreds(creds);
      }
      if (!jobsWidget.isAttached) {
        app.shell.add(jobsWidget, 'main');
      }
      app.shell.activateById(jobsWidget.id);
    };

    /** Create a new notebook pre-wired to the current Dremio session. */
    const newNotebook = async (creds: DremioCredentials, selectedItem: CatalogItem | null) => {
      const hostname = new URL(creds.url).hostname;
      const flightUrl = `${creds.useTls ? 'grpc+tls' : 'grpc+tcp'}://${hostname}:32010`;
      let flightAuthorizationHeader: string | null = null;
      try {
        flightAuthorizationHeader = await fetchFlightAuthorizationHeader(creds);
      } catch (error) {
        window.alert(`Cannot prepare Dremio Flight credentials: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }

      // Escape any double-quotes or backslashes that appear in credentials.
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

      let code: string;

      // Credentials are injected silently into the kernel (see below). OIDC uses
      // a short-lived Bearer header; password sessions keep the existing fields.
      code =
        `from adbc_driver_flightsql import dbapi\n` +
        `from adbc_driver_manager import DatabaseOptions\n` +
        `import os, pandas as pd\n` +
        `\n` +
        `# Credentials were injected into this kernel at notebook creation.\n` +
        `# Re-open via the Dremio sidebar button if the kernel restarts.\n` +
        `dremio_db_kwargs = {"adbc.flight.sql.rpc.with_cookie_middleware": "true"}\n` +
        `if os.environ.get("_DREMIO_AUTHORIZATION_HEADER"):\n` +
        `    dremio_db_kwargs[DatabaseOptions.AUTHORIZATION_HEADER.value] = os.environ["_DREMIO_AUTHORIZATION_HEADER"]\n` +
        `else:\n` +
        `    dremio_db_kwargs["username"] = os.environ.get("_DREMIO_USER", "")\n` +
        `    dremio_db_kwargs["password"] = os.environ.get("_DREMIO_PWD", "")\n` +
        `\n` +
        `dremio_conn = dbapi.connect(\n` +
        `    os.environ.get("_DREMIO_FLIGHT_URL", ""),\n` +
        `    db_kwargs=dremio_db_kwargs,\n` +
        `    autocommit=True,\n` +
        `)\n` +
        `\n` +
        `%load_ext sql\n` +
        `%sql dremio_conn --alias dremio\n` +
        `\n` +
        `%config SqlMagic.displaylimit = 50\n` +
        `%config SqlMagic.autopandas = True\n` +
        `\n` +
        `# Use %%sql at the top of a cell to write SQL directly`;

      await app.commands.execute('notebook:create-new', { kernelName: 'python3' });

      // currentWidget is the freshly created notebook
      const panel = nbTracker?.currentWidget as NotebookPanel | null | undefined;
      if (!panel) return;

      await panel.context.ready;
      // Wait for the kernel to be fully connected before injecting credentials.
      await panel.sessionContext.ready;

      const model = panel.content.model;
      if (!model) return;

      // Cell 0 (default empty cell) → Python setup code.
      const firstCell = model.cells.get(0);
      if (firstCell) {
        firstCell.sharedModel.setSource(code);
      }

      // Insert markdown intro at position 0; Python code shifts to position 1.
      const markdown =
        '# Notebook Title\n' +
        '\n' +
        '> _Replace this heading with your analysis title and describe what this notebook is about._\n' +
        '\n' +
        '---\n' +
        '\n' +
        '## Running SQL queries\n' +
        '\n' +
        'After running the **Setup** cell below, use SQL magic cells to query Dremio:\n' +
        '\n' +
        '| Magic | Use for |\n' +
        '|---|---|\n' +
        '| `%%sql` | Multi-line SQL — put this on the **first line** of a cell |\n' +
        '| `%sql SELECT ...` | Inline single-line query |\n' +
        '\n' +
        'Results are returned as **pandas DataFrames** automatically.\n' +
        '\n' +
        '**Tip:** Drag any table from the Dremio sidebar into a cell ' +
        'to insert a ready-made `SELECT` statement with all column names.\n' +
        '\n' +
        '📖 [JupySQL quick-start](https://jupysql.readthedocs.io/en/latest/quick-start.html) ' +
        '&nbsp;·&nbsp; ' +
        '[`%%sql` magic reference](https://jupysql.readthedocs.io/en/latest/api/magic-sql.html)';

      model.sharedModel.insertCell(0, {
        cell_type: 'markdown',
        source: markdown,
        metadata: {},
      });

      // Build the USE path from the selected catalog item so the %%sql cell
      // sets the right context. Rules:
      //  • SPACE or FOLDER selected → USE that path
      //  • Dataset (TABLE/VIEW) selected → USE its parent container path
      //  • SOURCE, HOME, or nothing selected → no USE statement
      let usePath: string[] | null = null;
      if (selectedItem) {
        const ct = selectedItem.containerType;
        const et = selectedItem.entityType;
        const dt = selectedItem.datasetType;
        if (ct === 'SPACE' || ct === 'FOLDER') {
          usePath = selectedItem.path;
        } else if (et === 'DATASET' || dt) {
          const parent = selectedItem.path.slice(0, -1);
          if (parent.length > 0) usePath = parent;
        }
      }
      const useStatement = usePath
        ? `USE ${usePath.map(p => `"${p}"`).join('.')};\n\n`
        : '';

      // Add %%sql starter cell at the end (position 2).
      model.sharedModel.insertCell(model.cells.length, {
        cell_type: 'code',
        source: `%%sql\n${useStatement}`,
        metadata: {},
      });

      // Silently inject credentials into the kernel as environment variables.
      // silent:true means no output, no history entry — never visible in the notebook.
      // The setup cell reads them back via os.environ.get("_DREMIO_USER/PWD").
      const kernel = panel.sessionContext.session?.kernel;
      if (kernel && (creds.username || creds.password || flightAuthorizationHeader)) {
        const injections: string[] = ['import os'];
        if (creds.username) injections.push(`os.environ["_DREMIO_USER"] = "${esc(creds.username)}"`);
        if (creds.password) injections.push(`os.environ["_DREMIO_PWD"] = "${esc(creds.password)}"`);
        if (flightAuthorizationHeader) injections.push(`os.environ["_DREMIO_AUTHORIZATION_HEADER"] = "${esc(flightAuthorizationHeader)}"`);
        if (flightUrl) injections.push(`os.environ["_DREMIO_FLIGHT_URL"] = "${esc(flightUrl)}"`);
        kernel.requestExecute({
          code: injections.join('; '),
          silent: true,
          store_history: false,
        });
      }

      app.shell.activateById(panel.id);
    };

    const createWidget = () => {
      const widget = new DremioWidget(
        showWiki,
        showJobs,
        (creds, item) => { void newNotebook(creds, item); },
        creds => { activeCreds = creds; }
      );
      void tracker.add(widget);
      return widget;
    };

    app.commands.addCommand(COMMAND_OPEN, {
      label: 'Open Dremio Catalog',
      icon: dremioIcon,
      execute: () => {
        if (tracker.currentWidget && !tracker.currentWidget.isDisposed) {
          app.shell.activateById(tracker.currentWidget.id);
          return;
        }
        const widget = createWidget();
        app.shell.add(widget, 'left', { rank: 200 });
        app.shell.activateById(widget.id);
      },
    });

    if (palette) {
      palette.addItem({ command: COMMAND_OPEN, category: 'Dremio' });
    }

    if (restorer) {
      restorer.restore(tracker, {
        command: COMMAND_OPEN,
        name: () => PANEL_ID,
      });
    }

    app.restored.then(() => {
      app.commands.execute(COMMAND_OPEN);
    });
  },
};

export default plugin;
