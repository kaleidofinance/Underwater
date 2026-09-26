/**
 * A Map that can roll back. Inside a transaction every key's first prior
 * value is remembered, so `rollback` restores the map exactly, which is how
 * an engine command stays atomic across its bookkeeping maps.
 *
 * Values are treated as immutable: replace a record with `set`, never mutate
 * one in place, or the undo log has nothing to restore.
 */
export class TxMap<K, V> {
  #map = new Map<K, V>();
  #undo: Map<K, V | undefined> | null = null;

  get size(): number {
    return this.#map.size;
  }

  get(key: K): V | undefined {
    return this.#map.get(key);
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  values(): IterableIterator<V> {
    return this.#map.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.#map.entries();
  }

  set(key: K, value: V): void {
    this.#remember(key);
    this.#map.set(key, value);
  }

  delete(key: K): void {
    this.#remember(key);
    this.#map.delete(key);
  }

  begin(): void {
    this.#undo = new Map();
  }

  commit(): void {
    this.#undo = null;
  }

  rollback(): void {
    if (!this.#undo) return;
    for (const [key, value] of this.#undo) {
      if (value === undefined) this.#map.delete(key);
      else this.#map.set(key, value);
    }
    this.#undo = null;
  }

  #remember(key: K): void {
    if (this.#undo && !this.#undo.has(key)) this.#undo.set(key, this.#map.get(key));
  }
}
