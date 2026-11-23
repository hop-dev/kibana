/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { chokeBuffers, chokePoints } from './choke_points';
import { dominatorBuffers, dominatorTree } from './dominators';
import { graphBuilder, type Graph } from './graph';
import { nodeReachTable } from './node_reach';
import type {
  EdgeReader,
  MultiSeedWalkOptions,
  MultiSeedWalkResult,
  SeedCompute,
  SeedReach,
} from './types';
import { reverseWalk, walkBuffers } from './walk';

// One walk back from every seed at once. Hop by hop, it reads the edges into the frontier, so it
// reads the union of what each seed's own walk would read, once. Every node that reaches a seed is
// in that union with every edge into it, so each seed's reach, hops and choke points come out of
// the union in memory exactly as they would from the whole graph.

const DEFAULT_TOP_CHOKE_POINTS = 10;
const DEFAULT_NODES_PAGE_SIZE = 1_000;

/** Lets the event loop run, then stops if the walk was aborted. */
const yieldToEventLoop = async (signal: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  signal.throwIfAborted();
};

const countedMask = (graph: Graph, isCounted?: (nodeId: string) => boolean): Uint8Array => {
  const counted = new Uint8Array(graph.nodeCount);
  if (!isCounted) return counted.fill(1);
  for (let v = 0; v < graph.nodeCount; v++) counted[v] = isCounted(graph.nameOf(v)) ? 1 : 0;
  return counted;
};

/**
 * Walks back from every seed at once over the reader, then works out each seed's reach and choke
 * points, and every node's hops and next node to each seed it reaches. Stops reading, with the cap
 * outcome, once more than maxEdgesRead edges have been read.
 */
export const multiSeedWalk = async (
  reader: EdgeReader,
  seedIds: readonly string[],
  {
    maxEdgesRead,
    signal,
    isCounted,
    onHop,
    onSeedComputed,
    topChokePoints = DEFAULT_TOP_CHOKE_POINTS,
    nodesPageSize = DEFAULT_NODES_PAGE_SIZE,
  }: MultiSeedWalkOptions
): Promise<MultiSeedWalkResult> => {
  const seeds = [...new Set(seedIds)];
  const builder = graphBuilder();
  let frontier = seeds.map(builder.intern);
  let edgesRead = 0;
  let hops = 0;

  // The walk: a node is new exactly when interning it adds it, so the id table is the visited set.
  for (let hop = 1; frontier.length > 0; hop++) {
    signal.throwIfAborted();
    const next: number[] = [];
    for await (const page of reader.edgesInto(frontier.map(builder.nameOf))) {
      for (const { fromId, kind, toId } of page) {
        const before = builder.nodeCount();
        const from = builder.intern(fromId);
        if (from === before) next.push(from);
        builder.addEdge(from, kind, builder.intern(toId));
      }
      edgesRead += page.length;
      if (edgesRead > maxEdgesRead) {
        onHop?.({ hop, frontierSize: frontier.length, edgesRead });
        return { outcome: 'cap', edgesRead, hops };
      }
      signal.throwIfAborted();
    }
    onHop?.({ hop, frontierSize: frontier.length, edgesRead });
    if (next.length > 0) hops++;
    frontier = next;
  }

  const graph = builder.build();
  await yieldToEventLoop(signal);
  const counted = countedMask(graph, isCounted);
  const walk = walkBuffers(graph);
  const dominators = dominatorBuffers(graph);
  const choke = chokeBuffers(graph, dominators);
  const reach = nodeReachTable(graph);
  // Every seed was interned before the walk, so each has a number.
  const roots = seeds.map((seedId) => graph.idOf(seedId) ?? -1);

  // Each seed's reach and choke points, counting the nodes it reaches.
  const seedReaches: SeedReach[] = [];
  const seconds = (from: number) => (performance.now() - from) / 1000;
  const times: Array<Omit<SeedCompute, 'nodeReachSeconds'>> = [];
  for (const [s, seedId] of seeds.entries()) {
    let at = performance.now();
    const reached = reverseWalk(graph, roots[s], walk);
    const reachedByHops = new Array<number>(reached.maxHops).fill(0);
    for (let i = 1; i < walk.size; i++) reachedByHops[walk.hops[walk.order[i]] - 1]++;
    reach.count(walk);
    const reachSeconds = seconds(at);
    at = performance.now();
    dominatorTree(graph, roots[s], dominators);
    const dominatorsSeconds = seconds(at);
    at = performance.now();
    seedReaches.push({
      seedId,
      edgesRead: reached.edgesRead,
      reachedByHops,
      chokePoints: chokePoints(graph, dominators, counted, choke, topChokePoints),
    });
    times.push({ seedId, reachSeconds, dominatorsSeconds, chokePointsSeconds: seconds(at) });
    await yieldToEventLoop(signal);
  }

  // Each node's hops and next node to every seed it reaches.
  reach.allocate();
  for (let s = 0; s < seeds.length; s++) {
    const at = performance.now();
    reverseWalk(graph, roots[s], walk);
    reach.fill(s, walk);
    onSeedComputed?.({ ...times[s], nodeReachSeconds: seconds(at) });
    await yieldToEventLoop(signal);
  }

  return {
    outcome: 'completed',
    edgesRead,
    hops,
    nodesReached: reach.nodesReached(),
    seeds: seedReaches,
    nodes: () => reach.pages(seeds, nodesPageSize),
  };
};
