/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { DominatorBuffers } from './dominators';
import type { EventLoopBudget } from './event_loop_budget';
import type { Graph } from './graph';
import type { ChokeLink, ChokeNode, ChokePoints } from './types';

// Choke points for one seed, from its dominator tree: the links and nodes every path to it
// passes through, and how many counted nodes each one cuts off.
//
// - A node cuts off everyone in its dominator subtree but itself.
// - A link from b to a cuts off b's whole subtree, b included, when a is b's immediate dominator,
//   it's the only link from b to a, and every other link out of b leads to a node b dominates.
//   That gives the dominating links without splitting every link with a midpoint node.
// - A node is reported only where it cuts off more than any one of its links: otherwise removing a
//   link is the smaller fix.

export interface ChokeBuffers {
  /** Counted nodes in each node's dominator subtree, itself included, by depth-first number. */
  readonly sub: Int32Array;
  /** Counted nodes cut off by removing the link into each node from its immediate dominator, or 0. */
  readonly linkCut: Int32Array;
  // Working arrays: the dominator tree's children, and an interval per node for "dominated by".
  readonly childOffsets: Int32Array;
  readonly children: Int32Array;
  readonly pre: Int32Array;
  readonly post: Int32Array;
  readonly stack: Int32Array;
  readonly stackAt: Int32Array;
  readonly maxChildLink: Int32Array;
}

/**
 * Buffers for choke points. Given the dominator buffers, they reuse its working arrays, which
 * dominatorTree no longer needs once the tree is built: the next dominatorTree call overwrites them,
 * so compute each seed's choke points before building the next tree.
 */
export const chokeBuffers = (graph: Graph, share?: DominatorBuffers): ChokeBuffers => {
  const n = graph.nodeCount;
  if (share) {
    return {
      sub: share.parent,
      linkCut: share.semi,
      childOffsets: new Int32Array(n + 1),
      children: share.ancestor,
      pre: share.label,
      post: share.bucketHead,
      stack: share.bucketNext,
      stackAt: share.stackNode,
      maxChildLink: share.stackEdge,
    };
  }
  return {
    sub: new Int32Array(n),
    linkCut: new Int32Array(n),
    childOffsets: new Int32Array(n + 1),
    children: new Int32Array(n),
    pre: new Int32Array(n),
    post: new Int32Array(n),
    stack: new Int32Array(n),
    stackAt: new Int32Array(n),
    maxChildLink: new Int32Array(n),
  };
};

/**
 * Fills sub and linkCut for the dominator tree in d, by depth-first number. Returns how many
 * counted nodes can reach the seed. counted is 1 for each node that counts.
 */
export const cuts = async (
  graph: Graph,
  d: DominatorBuffers,
  counted: Uint8Array,
  c: ChokeBuffers,
  budget: EventLoopBudget
): Promise<number> => {
  const { outOffsets, outTargets } = graph;
  const { num, vertex, idom, size } = d;
  const { sub, linkCut, childOffsets, children, pre, post, stack, stackAt } = c;

  // Counted nodes in each subtree. A dominator always has a lower number than the nodes it dominates.
  for (let i = 0; i < size; i++) sub[i] = counted[vertex[i]];
  for (let i = size - 1; i > 0; i--) sub[idom[i]] += sub[i];

  // The dominator tree's children, then an interval per node: x dominates y when y's interval
  // sits inside x's.
  childOffsets.fill(0, 0, size + 1);
  for (let i = 1; i < size; i++) childOffsets[idom[i] + 1]++;
  for (let i = 0; i < size; i++) childOffsets[i + 1] += childOffsets[i];
  for (let i = 0; i < size; i++) stackAt[i] = childOffsets[i];
  for (let i = 1; i < size; i++) children[stackAt[idom[i]]++] = i;
  let clock = 0;
  let top = 0;
  stack[0] = 0;
  stackAt[0] = childOffsets[0];
  pre[0] = clock++;
  while (top >= 0) {
    if (budget.spent()) await budget.yield();
    const v = stack[top];
    const k = stackAt[top];
    if (k === childOffsets[v + 1]) {
      post[v] = clock++;
      top--;
      continue;
    }
    stackAt[top] = k + 1;
    const child = children[k];
    pre[child] = clock++;
    top++;
    stack[top] = child;
    stackAt[top] = childOffsets[child];
  }
  const dominates = (x: number, y: number) => pre[x] <= pre[y] && post[y] <= post[x];

  // Dominating links: into node i from its immediate dominator.
  linkCut[0] = 0;
  for (let i = 1; i < size; i++) {
    if (budget.spent()) await budget.yield();
    const b = vertex[i];
    const a = idom[i];
    let linksToA = 0;
    let bypassed = false;
    for (let e = outOffsets[b]; e < outOffsets[b + 1] && !bypassed; e++) {
      const p = num[outTargets[e]];
      if (p === -1) continue;
      if (p === a) linksToA++;
      else if (!dominates(i, p)) bypassed = true;
    }
    linkCut[i] = linksToA === 1 && !bypassed ? sub[i] : 0;
  }
  return sub[0] - counted[vertex[0]];
};

/**
 * The top entries by cut off as they're offered, keeping the first offered of equal ones, as a
 * stable sort of them all would. Only the top are kept, so there's nothing large to sort.
 */
const topByCutOff = (top: number) => {
  const indices: number[] = [];
  const cutOffs: number[] = [];
  return {
    offer: (index: number, cutOff: number): void => {
      const full = indices.length === top;
      if (top === 0 || (full && cutOff <= cutOffs[top - 1])) return;
      let at = full ? top - 1 : indices.length;
      for (; at > 0 && cutOffs[at - 1] < cutOff; at--) {
        indices[at] = indices[at - 1];
        cutOffs[at] = cutOffs[at - 1];
      }
      indices[at] = index;
      cutOffs[at] = cutOff;
    },
    indices: (): readonly number[] => indices,
  };
};

/** The choke points for the dominator tree in d: the top links and nodes by counted nodes cut off. */
export const chokePoints = async (
  graph: Graph,
  d: DominatorBuffers,
  counted: Uint8Array,
  c: ChokeBuffers,
  budget: EventLoopBudget,
  top = 10
): Promise<ChokePoints> => {
  const countedReaching = await cuts(graph, d, counted, c, budget);
  const { vertex, idom, size } = d;
  const { sub, linkCut, maxChildLink } = c;

  const topLinks = topByCutOff(top);
  let dominatingLinks = 0;
  maxChildLink.fill(0, 0, size);
  for (let i = 1; i < size; i++) {
    if (budget.spent()) await budget.yield();
    if (linkCut[i] === 0) continue;
    dominatingLinks++;
    topLinks.offer(i, linkCut[i]);
    if (linkCut[i] > maxChildLink[idom[i]]) maxChildLink[idom[i]] = linkCut[i];
  }

  const topNodes = topByCutOff(top);
  for (let i = 1; i < size; i++) {
    if (budget.spent()) await budget.yield();
    const cutOff = sub[i] - counted[vertex[i]];
    if (cutOff > 0 && linkCut[i] === 0 && cutOff > maxChildLink[i]) topNodes.offer(i, cutOff);
  }

  const linkInto = (i: number): ChokeLink => {
    const b = vertex[i];
    const a = vertex[idom[i]];
    let kind = '';
    for (let e = graph.outOffsets[b]; e < graph.outOffsets[b + 1]; e++) {
      if (graph.outTargets[e] === a) kind = graph.kinds[graph.outKinds[e]];
    }
    return { fromId: graph.nameOf(b), kind, toId: graph.nameOf(a), cutOff: linkCut[i] };
  };
  return {
    countedReaching,
    dominatingLinks,
    links: topLinks.indices().map(linkInto),
    nodes: topNodes
      .indices()
      .map(
        (i): ChokeNode => ({ nodeId: graph.nameOf(vertex[i]), cutOff: sub[i] - counted[vertex[i]] })
      ),
  };
};
