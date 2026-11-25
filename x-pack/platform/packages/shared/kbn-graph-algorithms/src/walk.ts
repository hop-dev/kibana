/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EventLoopBudget } from './event_loop_budget';
import type { Graph } from './graph';

// The reverse walk from one seed: breadth first over the edges into each node, so every node that
// can reach the seed is found with its hops to it and the next node on one shortest path.

/** Reused between walks, so many seeds don't allocate many sets of arrays. */
export interface WalkBuffers {
  /** Hops to the seed, or -1 when the node can't reach it. */
  readonly hops: Int32Array;
  /** The next node on one shortest path to the seed, or -1. */
  readonly next: Int32Array;
  /** Nodes in the order they were reached, the seeds first. */
  readonly order: Int32Array;
  /** How many entries of order the last walk filled. */
  size: number;
}

export interface WalkResult {
  /** Nodes that can reach a seed, not counting the seeds walked from. */
  readonly reached: number;
  /** Edges the walk read: every edge into every node it reached. */
  readonly edgesRead: number;
  /** Hops from the furthest node reached. */
  readonly maxHops: number;
}

export const walkBuffers = (graph: Graph): WalkBuffers => ({
  hops: new Int32Array(graph.nodeCount).fill(-1),
  next: new Int32Array(graph.nodeCount).fill(-1),
  order: new Int32Array(graph.nodeCount),
  size: 0,
});

/**
 * Walks back from a seed, or from several at once (everything that reaches any of them, with hops
 * to the nearest). Its answers stay in the buffers until the next walk.
 */
export const reverseWalk = async (
  graph: Graph,
  seeds: number | readonly number[],
  buffers: WalkBuffers,
  budget: EventLoopBudget
): Promise<WalkResult> => {
  const roots = typeof seeds === 'number' ? [seeds] : seeds;
  const { inOffsets, inSources } = graph;
  const { hops, next, order } = buffers;

  // Clear only what the last walk set.
  for (let i = 0; i < buffers.size; i++) {
    hops[order[i]] = -1;
    next[order[i]] = -1;
  }

  let size = 0;
  for (const root of roots) {
    if (hops[root] === 0) continue;
    hops[root] = 0;
    order[size++] = root;
  }
  const rootCount = size;
  let edgesRead = 0;
  for (let head = 0; head < size; head++) {
    if (budget.spent()) await budget.yield();
    const v = order[head];
    const start = inOffsets[v];
    const end = inOffsets[v + 1];
    edgesRead += end - start;
    for (let e = start; e < end; e++) {
      const u = inSources[e];
      if (hops[u] !== -1) continue;
      hops[u] = hops[v] + 1;
      next[u] = v;
      order[size++] = u;
    }
  }
  buffers.size = size;
  return { reached: size - rootCount, edgesRead, maxHops: size > 0 ? hops[order[size - 1]] : 0 };
};
