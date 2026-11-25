/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EventLoopBudget } from './event_loop_budget';
import type { Graph } from './graph';

// Dominators for one seed, by Lengauer-Tarjan (the simple version, with path compression).
// It runs over the reversed graph, from the seed: node d dominates node x when every path
// from x to the seed passes through d. Remove d, and x loses every path.
//
// Everything is iterative, since a recursive depth-first search would overflow the stack on a
// reach of hundreds of thousands of nodes. Nodes are worked on by their depth-first number,
// 0 for the seed.

export interface DominatorBuffers {
  /** Each node's depth-first number in the last run, or -1 when it can't reach the seed. */
  readonly num: Int32Array;
  /** The node with each depth-first number. */
  readonly vertex: Int32Array;
  /** The depth-first number of each node's immediate dominator. -1 for the seed. */
  readonly idom: Int32Array;
  // Working arrays, by depth-first number.
  readonly parent: Int32Array;
  readonly semi: Int32Array;
  readonly ancestor: Int32Array;
  readonly label: Int32Array;
  readonly bucketHead: Int32Array;
  readonly bucketNext: Int32Array;
  // Stacks for the depth-first search and for path compression.
  readonly stackNode: Int32Array;
  readonly stackEdge: Int32Array;
  readonly path: Int32Array;
  /** How many nodes the last run numbered: the seed and every node that can reach it. */
  size: number;
}

export const dominatorBuffers = (graph: Graph): DominatorBuffers => {
  const n = graph.nodeCount;
  return {
    num: new Int32Array(n).fill(-1),
    vertex: new Int32Array(n),
    idom: new Int32Array(n),
    parent: new Int32Array(n),
    semi: new Int32Array(n),
    ancestor: new Int32Array(n),
    label: new Int32Array(n),
    bucketHead: new Int32Array(n),
    bucketNext: new Int32Array(n),
    stackNode: new Int32Array(n),
    stackEdge: new Int32Array(n),
    path: new Int32Array(n),
    size: 0,
  };
};

/**
 * Builds the dominator tree of everything that can reach the seed. Returns how many nodes
 * it covers. The tree stays in the buffers until the next run: buffers.vertex[i] is a node and
 * buffers.idom[i] the depth-first number of its immediate dominator.
 */
export const dominatorTree = async (
  graph: Graph,
  seed: number,
  b: DominatorBuffers,
  budget: EventLoopBudget
): Promise<number> => {
  const { inOffsets, inSources, outOffsets, outTargets } = graph;
  const { num, vertex, idom, parent, semi, ancestor, label, bucketHead, bucketNext } = b;

  for (let i = 0; i < b.size; i++) num[vertex[i]] = -1;

  // 1. Number the nodes depth first, from the seed, against the direction of the edges.
  num[seed] = 0;
  vertex[0] = seed;
  parent[0] = -1;
  let size = 1;
  b.stackNode[0] = seed;
  b.stackEdge[0] = inOffsets[seed];
  let top = 1;
  while (top > 0) {
    if (budget.spent()) await budget.yield();
    const v = b.stackNode[top - 1];
    const e = b.stackEdge[top - 1];
    if (e === inOffsets[v + 1]) {
      top--;
      continue;
    }
    b.stackEdge[top - 1] = e + 1;
    const u = inSources[e];
    if (num[u] !== -1) continue;
    num[u] = size;
    vertex[size] = u;
    parent[size] = num[v];
    size++;
    b.stackNode[top] = u;
    b.stackEdge[top] = inOffsets[u];
    top++;
  }
  b.size = size;

  for (let i = 0; i < size; i++) {
    semi[i] = i;
    label[i] = i;
    ancestor[i] = -1;
    bucketHead[i] = -1;
    idom[i] = -1;
  }

  // The node on the path to the forest root with the lowest semidominator, compressing as it goes.
  const evaluate = (v: number): number => {
    if (ancestor[v] === -1) return v;
    let depth = 0;
    let x = v;
    while (ancestor[ancestor[x]] !== -1) {
      b.path[depth++] = x;
      x = ancestor[x];
    }
    while (depth > 0) {
      x = b.path[--depth];
      const a = ancestor[x];
      if (semi[label[a]] < semi[label[x]]) label[x] = label[a];
      ancestor[x] = ancestor[a];
    }
    return label[v];
  };

  // 2. Semidominators from the last-numbered node back, and immediate dominators where they're
  // already certain. A node's predecessors here are the nodes its own edges point to.
  for (let w = size - 1; w > 0; w--) {
    if (budget.spent()) await budget.yield();
    const x = vertex[w];
    for (let e = outOffsets[x]; e < outOffsets[x + 1]; e++) {
      const p = num[outTargets[e]];
      if (p === -1) continue;
      const u = evaluate(p);
      if (semi[u] < semi[w]) semi[w] = semi[u];
    }
    bucketNext[w] = bucketHead[semi[w]];
    bucketHead[semi[w]] = w;
    const p = parent[w];
    ancestor[w] = p;
    for (let v = bucketHead[p]; v !== -1; v = bucketNext[v]) {
      const u = evaluate(v);
      idom[v] = semi[u] < semi[v] ? u : p;
    }
    bucketHead[p] = -1;
  }

  // 3. The rest, in number order.
  for (let w = 1; w < size; w++) {
    if (idom[w] !== semi[w]) idom[w] = idom[idom[w]];
  }
  idom[0] = -1;
  return size;
};
