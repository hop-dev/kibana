/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { chokeBuffers, chokePoints } from './choke_points';
import { dominatorBuffers, dominatorTree } from './dominators';
import { eventLoopBudget } from './event_loop_budget';
import { graphBuilder } from './graph';
import { multiSeedWalk } from './multi_seed_walk';
import type { Edge, EdgeReader, NodeReach } from './types';
import { reverseWalk, walkBuffers } from './walk';

// A hub with 30 members leading to s1, a cycle leading to s2, x reaching both, s2 reaching s1, and
// a part of the graph that reaches no seed.
const EDGES: readonly Edge[] = [
  ...Array.from({ length: 30 }, (_, i) => ({ fromId: `u${i}`, kind: 'member_of', toId: 'hub' })),
  { fromId: 'hub', kind: 'local_admin', toId: 's1' },
  { fromId: 'c1', kind: 'can_assume', toId: 'c2' },
  { fromId: 'c2', kind: 'can_assume', toId: 'c3' },
  { fromId: 'c3', kind: 'can_assume', toId: 'c1' },
  { fromId: 'c2', kind: 'bucket_policy', toId: 's2' },
  { fromId: 'x', kind: 'member_of', toId: 'hub' },
  { fromId: 'x', kind: 'member_of', toId: 'c1' },
  { fromId: 's2', kind: 'runs_as', toId: 's1' },
  { fromId: 'u0', kind: 'local_admin', toId: 'c3' },
  { fromId: 'z1', kind: 'member_of', toId: 'z2' },
];
const SEEDS = ['s1', 's2'];

/** Edges into the asked nodes, in pages of 4, recording what was asked. */
const memoryReader = (edges: readonly Edge[]) => {
  const asked: string[][] = [];
  const reader: EdgeReader = {
    async *edgesInto(nodeIds) {
      asked.push([...nodeIds]);
      const into = new Set(nodeIds);
      const matching = edges.filter(({ toId }) => into.has(toId));
      for (let at = 0; at < matching.length; at += 4) yield matching.slice(at, at + 4);
    },
  };
  return { reader, asked };
};

const signal = new AbortController().signal;
const budget = eventLoopBudget(signal);

const wholeGraph = () => {
  const builder = graphBuilder();
  for (const { fromId, kind, toId } of EDGES) {
    builder.addEdge(builder.intern(fromId), kind, builder.intern(toId));
  }
  return builder.build();
};

const completed = async (maxEdgesRead = Infinity) => {
  const { reader } = memoryReader(EDGES);
  const result = await multiSeedWalk(reader, SEEDS, { maxEdgesRead, signal });
  if (result.outcome !== 'completed') throw new Error(`walk ended with ${result.outcome}`);
  return result;
};

describe('multiSeedWalk', () => {
  it('gives each seed the reach, edges read and choke points of a walk over the whole graph', async () => {
    const result = await completed();
    const graph = wholeGraph();
    const walk = walkBuffers(graph);
    const dominators = dominatorBuffers(graph);
    const everyone = new Uint8Array(graph.nodeCount).fill(1);

    for (const seed of result.seeds) {
      const root = graph.idOf(seed.seedId) ?? -1;
      const reached = await reverseWalk(graph, root, walk, budget);
      const byHops = new Array<number>(reached.maxHops).fill(0);
      for (let i = 1; i < walk.size; i++) byHops[walk.hops[walk.order[i]] - 1]++;
      await dominatorTree(graph, root, dominators, budget);

      expect(seed.edgesRead).toBe(reached.edgesRead);
      expect(seed.reachedByHops).toEqual(byHops);
      expect(seed.chokePoints).toEqual(
        await chokePoints(graph, dominators, everyone, chokeBuffers(graph, dominators), budget)
      );
    }
    expect(result.seeds.map(({ seedId }) => seedId)).toEqual(SEEDS);
  });

  it('reads every edge into every node reached once, and nothing else', async () => {
    const { reader, asked } = memoryReader(EDGES);
    const result = await multiSeedWalk(reader, [...SEEDS, 's1'], { maxEdgesRead: 1_000, signal });
    const everyAsked = asked.flat();
    const graph = wholeGraph();
    const union = await reverseWalk(
      graph,
      SEEDS.map((seedId) => graph.idOf(seedId) ?? -1),
      walkBuffers(graph),
      budget
    );

    expect(new Set(everyAsked).size).toBe(everyAsked.length);
    expect(everyAsked).not.toContain('z2');
    expect(result.edgesRead).toBe(union.edgesRead);
    expect(result.edgesRead).toBe(EDGES.length - 1);
    expect(result.hops).toBe(union.maxHops);
  });

  it('gives every node reaching a seed its hops and a next node one hop closer by a real edge', async () => {
    const result = await completed();
    const graph = wholeGraph();
    const walk = walkBuffers(graph);
    const edges = new Set(EDGES.map(({ fromId, toId }) => `${fromId}>${toId}`));
    const nodes: NodeReach[] = [...result.nodes()].flat();
    const reachOf = new Map(nodes.map((node) => [node.nodeId, node]));

    expect(nodes).toHaveLength(result.nodesReached);
    expect(reachOf.has('z1')).toBe(false);
    expect(reachOf.get('s2')?.seeds).toEqual([{ seedId: 's1', hops: 1, nextNodeId: 's1' }]);
    for (const seedId of SEEDS) {
      await reverseWalk(graph, graph.idOf(seedId) ?? -1, walk, budget);
      for (let v = 0; v < graph.nodeCount; v++) {
        const hops = walk.hops[v];
        const pair = reachOf.get(graph.nameOf(v))?.seeds.find((s) => s.seedId === seedId);
        if (hops <= 0) {
          expect(pair).toBeUndefined();
          continue;
        }
        expect(pair?.hops).toBe(hops);
        expect(edges.has(`${graph.nameOf(v)}>${pair?.nextNodeId}`)).toBe(true);
        expect(walk.hops[graph.idOf(pair?.nextNodeId ?? '') ?? -1]).toBe(hops - 1);
      }
    }
  });

  it('hands nodes out a page at a time', async () => {
    const { reader } = memoryReader(EDGES);
    const result = await multiSeedWalk(reader, SEEDS, {
      maxEdgesRead: Infinity,
      signal,
      nodesPageSize: 7,
    });
    if (result.outcome !== 'completed') throw new Error(result.outcome);
    const sizes = [...result.nodes()].map((page) => page.length);

    expect(sizes.slice(0, -1).every((size) => size === 7)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(result.nodesReached);
  });

  it('counts only the nodes isCounted names in choke points', async () => {
    const { reader } = memoryReader(EDGES);
    const result = await multiSeedWalk(reader, ['s1'], {
      maxEdgesRead: Infinity,
      signal,
      isCounted: (nodeId) => nodeId.startsWith('u'),
    });
    if (result.outcome !== 'completed') throw new Error(result.outcome);

    expect(result.seeds[0].chokePoints.countedReaching).toBe(30);
  });

  it('stops reading and returns the cap outcome once it reads more than the cap', async () => {
    const { reader } = memoryReader(EDGES);
    const hops: number[] = [];
    const result = await multiSeedWalk(reader, SEEDS, {
      maxEdgesRead: 10,
      signal,
      onHop: ({ hop }) => hops.push(hop),
    });

    expect(result).toEqual({ outcome: 'cap', edgesRead: 11, hops: 1 });
    expect(hops).toEqual([1, 2]);
  });

  it('stops when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { reader } = memoryReader(EDGES);

    await expect(
      multiSeedWalk(reader, SEEDS, { maxEdgesRead: Infinity, signal: controller.signal })
    ).rejects.toThrow();
  });
});
