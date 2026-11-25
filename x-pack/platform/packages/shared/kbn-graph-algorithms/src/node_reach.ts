/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Graph } from './graph';
import type { NodeReach, NodeSeedCount } from './types';
import type { WalkBuffers } from './walk';

// Every node's hops and next node to each seed it reaches, in typed arrays. Filled in two passes
// over the seeds' walks: a count per node, then the pairs, grouped by node. About 9 bytes a pair:
// the seed's number, the next node's number and a byte of hops. Only nodes() turns them back into
// string ids, a page at a time.

export interface NodeReachTable {
  /** Pass 1: counts the nodes the last single-seed walk in the buffers reached. */
  readonly count: (walk: WalkBuffers) => void;
  /** Sizes the pairs from the counts. Call once, between the passes. */
  readonly allocate: () => void;
  /** Pass 2: stores the last single-seed walk in the buffers, for the seed with this number. */
  readonly fill: (seed: number, walk: WalkBuffers) => void;
  /** Nodes that reach at least one seed, seeds reaching other seeds included. */
  readonly nodesReached: () => number;
  /** Every node that reaches a seed, pageSize at a time. */
  readonly pages: (seedIds: readonly string[], pageSize: number) => Iterable<NodeReach[]>;
  /** Every node that reaches a seed, with how many it reaches, without building each pair. */
  readonly seedCounts: () => Iterable<NodeSeedCount>;
}

const MAX_HOPS = 255;

export const nodeReachTable = (graph: Graph): NodeReachTable => {
  const n = graph.nodeCount;
  const counts = new Int32Array(n);
  let offsets = new Int32Array(0);
  let seedOf = new Int32Array(0);
  let hopsOf = new Uint8Array(0);
  let nextOf = new Int32Array(0);

  return {
    // order[0] is the seed itself, which doesn't reach itself.
    count: ({ order, size }) => {
      for (let i = 1; i < size; i++) counts[order[i]]++;
    },
    allocate: () => {
      offsets = new Int32Array(n + 1);
      for (let v = 0; v < n; v++) offsets[v + 1] = offsets[v] + counts[v];
      const pairs = offsets[n];
      seedOf = new Int32Array(pairs);
      hopsOf = new Uint8Array(pairs);
      nextOf = new Int32Array(pairs);
      // The counts become each node's write cursor.
      counts.set(offsets.subarray(0, n));
    },
    fill: (seed, { order, size, hops, next }) => {
      for (let i = 1; i < size; i++) {
        const v = order[i];
        if (hops[v] > MAX_HOPS) throw new Error(`a node is more than ${MAX_HOPS} hops from a seed`);
        const at = counts[v]++;
        seedOf[at] = seed;
        hopsOf[at] = hops[v];
        nextOf[at] = next[v];
      }
    },
    nodesReached: () => {
      let reached = 0;
      for (let v = 0; v < n; v++) if (offsets[v + 1] > offsets[v]) reached++;
      return reached;
    },
    *pages(seedIds, pageSize) {
      let page: NodeReach[] = [];
      for (let v = 0; v < n; v++) {
        const start = offsets[v];
        const end = offsets[v + 1];
        if (end === start) continue;
        const seeds = [];
        for (let at = start; at < end; at++) {
          seeds.push({
            seedId: seedIds[seedOf[at]],
            hops: hopsOf[at],
            nextNodeId: graph.nameOf(nextOf[at]),
          });
        }
        page.push({ nodeId: graph.nameOf(v), seeds });
        if (page.length === pageSize) {
          yield page;
          page = [];
        }
      }
      if (page.length > 0) yield page;
    },
    *seedCounts() {
      for (let v = 0; v < n; v++) {
        const seedsReached = offsets[v + 1] - offsets[v];
        if (seedsReached > 0) yield { nodeId: graph.nameOf(v), seedsReached };
      }
    },
  };
};
