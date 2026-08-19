import * as React from 'react';
import { useEffect, useRef } from 'react';
import * as ReactDOM from 'react-dom';

export interface ContextMenuItem {
  label: string;
  icon?: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Use capture so we see the event before any other handler
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  return ReactDOM.createPortal(
    <div
      ref={ref}
      className="dremio-context-menu"
      style={{ position: 'fixed', left: x, top: y }}
      onContextMenu={e => e.preventDefault()}
    >
      {items.map((item, i) => (
        <React.Fragment key={i}>
          {item.separator && <div className="dremio-context-menu-separator" />}
          <button
            className={`dremio-context-menu-item${item.danger ? ' dremio-context-menu-item--danger' : ''}`}
            disabled={item.disabled}
            onMouseDown={e => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            {item.icon && (
              <span className="dremio-context-menu-icon">{item.icon}</span>
            )}
            {item.label}
          </button>
        </React.Fragment>
      ))}
    </div>,
    document.body
  );
}
