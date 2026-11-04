import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { idbDel, idbGet, idbSet } from './idb';

/** Find the connection the module has cached, by watching which database runs a transaction. */
async function cachedConnection(): Promise<IDBDatabase> {
  const original = IDBDatabase.prototype.transaction;
  let db: IDBDatabase | undefined;
  IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
    db = this;
    return original.apply(this, args);
  };
  try {
    await idbGet('probe');
  } finally {
    IDBDatabase.prototype.transaction = original;
  }
  return db!;
}

describe('idb store', () => {
  it('reads, writes and deletes', async () => {
    await idbSet('k', { a: 1 });
    expect(await idbGet('k')).toEqual({ a: 1 });
    await idbDel('k');
    expect(await idbGet('k')).toBeUndefined();
  });

  it('reopens the database after the browser closed the connection', async () => {
    await idbSet('k', 1);
    const db = await cachedConnection();
    // What the browser does to e.g. a backgrounded tab.
    db.close();
    expect(() => db.transaction('keyval')).toThrow(expect.objectContaining({ name: 'InvalidStateError' }));

    await idbSet('k', 2);
    expect(await idbGet('k')).toBe(2);
    expect(await cachedConnection()).not.toBe(db);
  });
});
