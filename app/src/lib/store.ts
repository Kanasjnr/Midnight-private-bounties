// Small external stores, read with useSyncExternalStore. The app keeps no
// effects: anything that comes from outside React (a clock, the URL, browser
// storage, the indexer, a fetch) is a store, and only the components that
// read a store rerender when its value changes.
import { useSyncExternalStore } from "react";
import type { Observable } from "rxjs";

type Listener = () => void;

export interface Store<T> {
  get: () => T;
  subscribe: (listener: Listener) => () => void;
}

/**
 * A value pushed from outside. `start` runs while anyone is subscribed and
 * returns how to stop; it gets `set` to publish a new value.
 */
export function externalStore<T>(initial: T, start: (set: (v: T) => void) => () => void): Store<T> {
  let value = initial;
  let stop: (() => void) | null = null;
  const listeners = new Set<Listener>();
  const set = (v: T) => {
    if (Object.is(v, value)) return;
    value = v;
    for (const l of listeners) l();
  };
  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) stop = start(set);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop?.();
          stop = null;
        }
      };
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** The result of one async call, made once per store: null until it resolves, and if it fails. */
export function promiseStore<T>(run: () => Promise<T>): Store<T | null> {
  let promise: Promise<T> | null = null;
  return externalStore<T | null>(null, (set) => {
    let live = true;
    promise ??= run();
    promise.then(
      (v) => live && set(v),
      () => live && set(null),
    );
    return () => {
      live = false;
    };
  });
}

export interface Streamed<T> {
  value: T | null;
  error: Error | null;
}

/** The latest value of an observable, and its error if it failed. */
export function observableStore<T>(source: Observable<T>): Store<Streamed<T>> {
  return externalStore<Streamed<T>>({ value: null, error: null }, (set) => {
    const sub = source.subscribe({
      next: (value) => set({ value, error: null }),
      error: (err: unknown) => set({ value: null, error: err instanceof Error ? err : new Error(String(err)) }),
    });
    return () => sub.unsubscribe();
  });
}

/** A store that never changes, for when there's nothing to read yet. */
export function constantStore<T>(value: T): Store<T> {
  return { get: () => value, subscribe: () => () => {} };
}

/** The time, as `read()` of Date.now(), refreshed every `intervalMs` while anyone reads it. */
export function clockStore<T>(intervalMs: number, read: (ms: number) => T): Store<T> {
  return externalStore(read(Date.now()), (set) => {
    set(read(Date.now()));
    const id = window.setInterval(() => set(read(Date.now())), intervalMs);
    return () => window.clearInterval(id);
  });
}

export interface Poll<T> {
  store: Store<T | null>;
  /** Poll now instead of waiting for the interval, e.g. right after a transaction. */
  refresh: () => void;
}

/**
 * `read()` every `intervalMs` while anyone is subscribed; null until the first
 * reply, and after a failed one. Replies with the same `key` as the last one
 * are dropped, so an unchanged balance doesn't rerender anything.
 */
export function pollStore<T>(read: () => Promise<T>, intervalMs: number, key: (v: T) => string = String): Poll<T> {
  let poll: (() => void) | null = null;
  let last: string | null = null;
  const store = externalStore<T | null>(null, (set) => {
    let live = true;
    poll = () =>
      void read().then(
        (v) => {
          if (!live || key(v) === last) return;
          last = key(v);
          set(v);
        },
        () => {
          if (!live) return;
          last = null;
          set(null);
        },
      );
    poll();
    const id = window.setInterval(poll, intervalMs);
    return () => {
      live = false;
      poll = null;
      window.clearInterval(id);
    };
  });
  return { store, refresh: () => poll?.() };
}

export interface Settled<T> {
  value: T | null;
  error: Error | null;
  pending: boolean;
}

/** Like promiseStore, but keeps the error and says while it's running. */
export function settledStore<T>(run: () => Promise<T>): Store<Settled<T>> {
  let promise: Promise<T> | null = null;
  return externalStore<Settled<T>>({ value: null, error: null, pending: true }, (set) => {
    let live = true;
    promise ??= run();
    promise.then(
      (value) => live && set({ value, error: null, pending: false }),
      (err: unknown) => live && set({ value: null, error: err instanceof Error ? err : new Error(String(err)), pending: false }),
    );
    return () => {
      live = false;
    };
  });
}
