import { Message } from '@lumino/messaging';
import { Widget } from '@lumino/widgets';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { WikiViewer } from './components/WikiViewer';
import { DremioCredentials } from './api';

let _counter = 0;

export class WikiWidget extends Widget {
  private _itemTitle = '';
  private _markdown = '';
  private _itemId = '';
  private _version: number | undefined;
  private _creds: DremioCredentials | null = null;
  private _mounted = false;

  constructor() {
    super();
    this.id = `jupyter-dremio:wiki-${++_counter}`;
    this.title.label = 'Dremio Wiki';
    this.title.closable = true;
    this.addClass('jp-DremioWikiWidget');
  }

  /** Update content in place — creates or replaces whatever is currently shown. */
  setContent(
    title: string,
    markdown: string,
    itemId: string,
    version: number | undefined,
    creds: DremioCredentials
  ): void {
    this._itemTitle = title;
    this._markdown = markdown;
    this._itemId = itemId;
    this._version = version;
    this._creds = creds;
    this.title.label = title ? `Wiki: ${title}` : 'Dremio Wiki';
    if (this._mounted) {
      this._render();
    }
  }

  protected onAfterAttach(_msg: Message): void {
    this._mounted = true;
    this._render();
  }

  protected onBeforeDetach(_msg: Message): void {
    this._mounted = false;
    ReactDOM.unmountComponentAtNode(this.node);
  }

  private _render(): void {
    ReactDOM.render(
      React.createElement(WikiViewer, {
        title: this._itemTitle,
        markdown: this._markdown,
        itemId: this._itemId,
        version: this._version,
        creds: this._creds,
      }),
      this.node
    );
  }
}
