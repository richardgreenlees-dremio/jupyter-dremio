import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
  ILayoutRestorer,
} from '@jupyterlab/application';
import { ICommandPalette, WidgetTracker } from '@jupyterlab/apputils';
import { INotebookTracker, NotebookPanel } from '@jupyterlab/notebook';
import { Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { dremioIcon } from './icons';
import { DremioPanel } from './components/DremioPanel';
import { WikiWidget } from './WikiWidget';
import { JobsWidget } from './JobsWidget';
import { DremioCredentials, CatalogItem } from './api';

const PLUGIN_ID = 'jupyter-dremio:plugin';
const PANEL_ID = 'jupyter-dremio:panel';
const COMMAND_OPEN = 'jupyter-dremio:open';

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

  constructor(
    showWiki: (
      name: string,
      markdown: string,
      itemId: string,
      version: number | undefined,
      creds: DremioCredentials
    ) => void,
    showJobs: (creds: DremioCredentials) => void,
    newNotebook: (creds: DremioCredentials, item: CatalogItem | null) => void
  ) {
    super();
    this._showWiki = showWiki;
    this._showJobs = showJobs;
    this._newNotebook = newNotebook;
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

      // Escape any double-quotes or backslashes that appear in credentials.
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

      let code: string;

      // Both username and password are injected silently into the kernel (see below).
      // The notebook cell reads them from os.environ so nothing sensitive is stored
      // on disk — the same .ipynb can be shared with any user unchanged.
      code =
        `from adbc_driver_flightsql import dbapi\n` +
        `import os, pandas as pd\n` +
        `\n` +
        `# Credentials were injected into this kernel at notebook creation.\n` +
        `# Re-open via the Dremio sidebar button if the kernel restarts.\n` +
        `dremio_conn = dbapi.connect(\n` +
        `    "${flightUrl}",\n` +
        `    db_kwargs={\n` +
        `        "username": os.environ.get("_DREMIO_USER", ""),\n` +
        `        "password": os.environ.get("_DREMIO_PWD", ""),\n` +
        `        "adbc.flight.sql.rpc.with_cookie_middleware": "true",\n` +
        `    },\n` +
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

      // Silently inject username + password into the kernel as environment variables.
      // silent:true means no output, no history entry — never visible in the notebook.
      // The setup cell reads them back via os.environ.get("_DREMIO_USER/PWD").
      const kernel = panel.sessionContext.session?.kernel;
      if (kernel && (creds.username || creds.password)) {
        const injections: string[] = ['import os'];
        if (creds.username) injections.push(`os.environ["_DREMIO_USER"] = "${esc(creds.username)}"`);
        if (creds.password) injections.push(`os.environ["_DREMIO_PWD"] = "${esc(creds.password)}"`);
        kernel.requestExecute({
          code: injections.join('; '),
          silent: true,
          store_history: false,
        });
      }

      app.shell.activateById(panel.id);
    };

    const createWidget = () => {
      const widget = new DremioWidget(showWiki, showJobs, (creds, item) => { void newNotebook(creds, item); });
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
