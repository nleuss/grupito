// Minimal observable store + Preact hook.
import { useEffect, useRef, useState } from 'preact/hooks';

export class Store<T extends object> {
  private state: T;
  private subs = new Set<(s: T) => void>();

  constructor(initial: T) {
    this.state = initial;
  }

  get(): T {
    return this.state;
  }

  set(patch: Partial<T> | ((s: T) => Partial<T>)) {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    let changed = false;
    for (const k in p) {
      if (!Object.is((this.state as Record<string, unknown>)[k], (p as Record<string, unknown>)[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...p };
    for (const fn of this.subs) fn(this.state);
  }

  subscribe(fn: (s: T) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** Subscribe a component to a slice of the store; re-renders only when the slice changes (shallowly). */
export function useStore<T extends object, S>(store: Store<T>, selector: (s: T) => S): S {
  const [, force] = useState(0);
  const selRef = useRef(selector);
  selRef.current = selector;
  const valRef = useRef<S>(selector(store.get()));
  valRef.current = selector(store.get());
  useEffect(
    () =>
      store.subscribe((s) => {
        const next = selRef.current(s);
        if (!shallowEqual(next, valRef.current)) {
          valRef.current = next;
          force((n) => n + 1);
        }
      }),
    [store],
  );
  return valRef.current;
}
