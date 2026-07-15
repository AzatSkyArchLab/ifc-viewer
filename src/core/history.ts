/**
 * Minimal undo/redo over full state snapshots. Actions need not be individually
 * invertible: callers `record()` a clone of the state *before* a change, and
 * undo/redo swap whole snapshots. Generic over the state type `T`.
 */
export class History<T> {
  private past: T[] = [];
  private future: T[] = [];

  constructor(
    private clone: (s: T) => T,
    private max = 50,
  ) {}

  /** Store the pre-change snapshot and drop the redo stack. */
  record(snapshot: T): void {
    this.past.push(this.clone(snapshot));
    if (this.past.length > this.max) this.past.shift();
    this.future = [];
  }

  /** Returns the state to restore, moving `current` onto the redo stack. */
  undo(current: T): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(this.clone(current));
    return prev;
  }

  /** Returns the state to re-apply, moving `current` back onto the undo stack. */
  redo(current: T): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.clone(current));
    return next;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}
