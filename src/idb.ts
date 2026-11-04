import { createStore, del, get, set, type UseStore } from 'idb-keyval';

// Same names idb-keyval uses by default, so data saved before keeps loading.
const DB_NAME = 'keyval-store';
const STORE_NAME = 'keyval';

let store: UseStore | undefined;

/**
 * Run `fn` against the cached connection, reopening it once if the browser
 * closed it. idb-keyval keeps one connection forever, but browsers close
 * IndexedDB connections (e.g. while a tab is in the background), after which
 * every transaction throws InvalidStateError ("The database connection is
 * closing.") until the page reloads.
 */
async function withStore<T>(fn: (s: UseStore) => Promise<T>): Promise<T> {
  store ??= createStore(DB_NAME, STORE_NAME);
  try {
    return await fn(store);
  } catch (e) {
    if ((e as DOMException | undefined)?.name !== 'InvalidStateError') throw e;
    store = createStore(DB_NAME, STORE_NAME);
    return fn(store);
  }
}

export const idbGet = <T>(key: string) => withStore((s) => get<T>(key, s));
export const idbSet = (key: string, value: unknown) => withStore((s) => set(key, value, s));
export const idbDel = (key: string) => withStore((s) => del(key, s));
