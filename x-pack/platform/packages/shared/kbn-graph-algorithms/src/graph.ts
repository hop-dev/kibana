/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { packedIdTable } from './id_table';

// The graph in memory: string ids become dense numbers, and edges are held both ways as
// compressed sparse rows in typed arrays. For node v, its edges sit between offsets[v] and
// offsets[v + 1]. Built once, never changed.

export interface Graph {
  readonly nameOf: (v: number) => string;
  /** The dense number of a string id, if the graph has it. */
  readonly idOf: (id: string) => number | undefined;
  /** Edge kinds, by the kind number stored per edge. */
  readonly kinds: readonly string[];
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** Edges into each node: inSources holds where each one comes from. */
  readonly inOffsets: Int32Array;
  readonly inSources: Int32Array;
  readonly inKinds: Uint8Array;
  /** Edges out of each node: outTargets holds where each one goes. */
  readonly outOffsets: Int32Array;
  readonly outTargets: Int32Array;
  readonly outKinds: Uint8Array;
}

export interface GraphBuilder {
  /** The dense number of a string id, adding the node if it's new. */
  readonly intern: (id: string) => number;
  readonly nameOf: (v: number) => string;
  readonly nodeCount: () => number;
  readonly addEdge: (from: number, kind: string, to: number) => void;
  /** Builds the graph. The builder can't be used afterwards. */
  readonly build: () => Graph;
}

const MAX_KINDS = 256;
/** Edges the staging arrays hold before they first double. */
const STAGING_EDGES = 65_536;

interface Adjacency {
  readonly offsets: Int32Array;
  readonly ends: Int32Array;
  readonly kinds: Uint8Array;
}

/** One direction of adjacency, by counting sort: offsets per node, then the far end of each edge. */
const compress = (
  nodeCount: number,
  edgeCount: number,
  near: Int32Array,
  far: Int32Array,
  kind: Uint8Array
): Adjacency => {
  const offsets = new Int32Array(nodeCount + 1);
  for (let e = 0; e < edgeCount; e++) offsets[near[e] + 1]++;
  for (let v = 0; v < nodeCount; v++) offsets[v + 1] += offsets[v];
  const ends = new Int32Array(edgeCount);
  const kinds = new Uint8Array(edgeCount);
  const cursor = offsets.slice(0, nodeCount);
  for (let e = 0; e < edgeCount; e++) {
    const at = cursor[near[e]]++;
    ends[at] = far[e];
    kinds[at] = kind[e];
  }
  return { offsets, ends, kinds };
};

export const graphBuilder = (): GraphBuilder => {
  const table = packedIdTable();
  const kindNumber = new Map<string, number>();
  const kinds: string[] = [];

  // Edges as they arrive, in arrays that double when full.
  let src = new Int32Array(STAGING_EDGES);
  let dst = new Int32Array(STAGING_EDGES);
  let kind = new Uint8Array(STAGING_EDGES);
  let edgeCount = 0;

  const numberOf = (k: string): number => {
    const known = kindNumber.get(k);
    if (known !== undefined) return known;
    if (kinds.length === MAX_KINDS) throw new Error(`more than ${MAX_KINDS} edge kinds`);
    kindNumber.set(k, kinds.length);
    kinds.push(k);
    return kinds.length - 1;
  };

  const grow = (): void => {
    const size = src.length * 2;
    const grownSrc = new Int32Array(size);
    const grownDst = new Int32Array(size);
    const grownKind = new Uint8Array(size);
    grownSrc.set(src);
    grownDst.set(dst);
    grownKind.set(kind);
    [src, dst, kind] = [grownSrc, grownDst, grownKind];
  };

  return {
    intern: table.intern,
    nameOf: table.nameOf,
    nodeCount: table.size,
    addEdge: (from, k, to) => {
      if (edgeCount === src.length) grow();
      src[edgeCount] = from;
      dst[edgeCount] = to;
      kind[edgeCount] = numberOf(k);
      edgeCount++;
    },
    build: () => {
      const nodeCount = table.size();
      const reverse = compress(nodeCount, edgeCount, dst, src, kind);
      const forward = compress(nodeCount, edgeCount, src, dst, kind);
      [src, dst, kind] = [new Int32Array(0), new Int32Array(0), new Uint8Array(0)];
      return {
        nameOf: table.nameOf,
        idOf: table.get,
        kinds,
        nodeCount,
        edgeCount,
        inOffsets: reverse.offsets,
        inSources: reverse.ends,
        inKinds: reverse.kinds,
        outOffsets: forward.offsets,
        outTargets: forward.ends,
        outKinds: forward.kinds,
      };
    },
  };
};
