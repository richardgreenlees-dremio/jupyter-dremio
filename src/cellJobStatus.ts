/** Return true for JupySQL cell forms used to submit Dremio SQL. */
export function isDremioSqlCell(source: string): boolean {
  return /^\s*%%sql(?:[^\n]*)?(?:\n|$)/i.test(source) ||
    /^\s*(?:[A-Za-z_]\w*\s*=\s*)?%sql\s+/i.test(source);
}

interface CellRunState {
  pending: number[];
  current: number;
}

/** Match completion events to the newest execution scheduled for each cell. */
export class CellRunTracker {
  private _sequence = 0;
  private _states = new WeakMap<object, CellRunState>();

  start(cell: object): void {
    const token = ++this._sequence;
    const state = this._states.get(cell) ?? { pending: [], current: token };
    state.pending.push(token);
    state.current = token;
    this._states.set(cell, state);
  }

  finish(cell: object): boolean {
    const state = this._states.get(cell);
    if (!state?.pending.length) return false;
    return state.pending.shift() === state.current;
  }
}
