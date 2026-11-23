/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// String ids to dense numbers and back. Every id's UTF-8 bytes sit in one growing buffer, found
// through an open-addressing hash table of numbers, so there is no JavaScript string per node and
// nothing for the garbage collector to trace.

export interface IdTable {
  /** The id's number, adding it if it's new. */
  readonly intern: (id: string) => number;
  readonly get: (id: string) => number | undefined;
  readonly nameOf: (v: number) => string;
  readonly size: () => number;
  /** Bytes held by the table's buffers. */
  readonly bufferBytes: () => number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const HASH_START = 0x811c9dc5;
const HASH_PRIME = 0x01000193;

/** A multiply-add hash of the first n bytes, as a slot in a table of tableSize slots. */
const hashOf = (b: Uint8Array, n: number): number => {
  let h = HASH_START;
  // Math.imul keeps h a 32-bit integer, so the sum below stays exact.
  for (let i = 0; i < n; i++) h = Math.imul(h, HASH_PRIME) + b[i];
  return h;
};

/**
 * A hash's slot. Stored in an Int32Array, a hash wraps to 32 bits, which leaves its slot the same:
 * table sizes are powers of two.
 */
const slotOf = (hash: number, tableSize: number): number =>
  ((hash % tableSize) + tableSize) % tableSize;

export const packedIdTable = (): IdTable => {
  let bytes = new Uint8Array(2 ** 24);
  let used = 0;
  // offsets[v] is where id v starts, offsets[v + 1] where it ends.
  let offsets = new Int32Array(2 ** 20);
  let count = 0;
  // Each id's hash, so growing the slots doesn't hash every id again.
  let hashes = new Int32Array(2 ** 16);
  // Slots hold id + 1, or 0 when empty. Kept under half full, and a power of two long.
  let slots = new Int32Array(2 ** 21);
  let scratch = new Uint8Array(1024);

  const sameAs = (v: number, b: Uint8Array, n: number): boolean => {
    const start = offsets[v];
    if (offsets[v + 1] - start !== n) return false;
    for (let i = 0; i < n; i++) if (bytes[start + i] !== b[i]) return false;
    return true;
  };
  const encode = (id: string): number => {
    if (scratch.length < id.length * 3) scratch = new Uint8Array(id.length * 3);
    return encoder.encodeInto(id, scratch).written;
  };
  const find = (n: number, hash: number): number => {
    let s = slotOf(hash, slots.length);
    while (slots[s] !== 0) {
      if (sameAs(slots[s] - 1, scratch, n)) return s;
      s = (s + 1) % slots.length;
    }
    return s;
  };
  const rehash = (): void => {
    slots = new Int32Array(slots.length * 2);
    for (let v = 0; v < count; v++) {
      let s = slotOf(hashes[v], slots.length);
      while (slots[s] !== 0) s = (s + 1) % slots.length;
      slots[s] = v + 1;
    }
  };

  return {
    intern: (id) => {
      const n = encode(id);
      const hash = hashOf(scratch, n);
      const s = find(n, hash);
      if (slots[s] !== 0) return slots[s] - 1;
      if (used + n > bytes.length) {
        const grown = new Uint8Array(Math.max(bytes.length * 2, used + n));
        grown.set(bytes.subarray(0, used));
        bytes = grown;
      }
      if (count + 2 > offsets.length) {
        const grown = new Int32Array(offsets.length * 2);
        grown.set(offsets);
        offsets = grown;
      }
      if (count === hashes.length) {
        const grown = new Int32Array(hashes.length * 2);
        grown.set(hashes);
        hashes = grown;
      }
      bytes.set(scratch.subarray(0, n), used);
      offsets[count] = used;
      used += n;
      offsets[count + 1] = used;
      hashes[count] = hash;
      const v = count++;
      slots[s] = v + 1;
      if (count * 2 > slots.length) rehash();
      return v;
    },
    get: (id) => {
      const n = encode(id);
      const s = find(n, hashOf(scratch, n));
      return slots[s] === 0 ? undefined : slots[s] - 1;
    },
    nameOf: (v) => decoder.decode(bytes.subarray(offsets[v], offsets[v + 1])),
    size: () => count,
    bufferBytes: () => bytes.byteLength + offsets.byteLength + hashes.byteLength + slots.byteLength,
  };
};
