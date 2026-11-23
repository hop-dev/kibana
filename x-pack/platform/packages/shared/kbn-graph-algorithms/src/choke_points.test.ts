/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { chokeBuffers, chokePoints, cuts } from './choke_points';
import { dominatorBuffers, dominatorTree } from './dominators';
import { eventLoopBudget } from './event_loop_budget';
import { graphBuilder, type Graph } from './graph';

// Lengauer-Tarjan and the links derived from it, against the definition on random small graphs:
// take every node and every link away in turn, walk again, and count who is cut off.

/** Counted nodes that reach the seed, the seed excluded, with one node or link taken away. */
const countedReaching = (
  graph: Graph,
  seed: number,
  counted: Uint8Array,
  removed: { node?: number; edge?: number } = {}
): number => {
  if (removed.node === seed) return 0;
  const { inOffsets, inSources } = graph;
  const seen = new Uint8Array(graph.nodeCount);
  const queue = new Int32Array(graph.nodeCount);
  seen[seed] = 1;
  queue[0] = seed;
  let size = 1;
  let count = 0;
  for (let head = 0; head < size; head++) {
    const v = queue[head];
    for (let e = inOffsets[v]; e < inOffsets[v + 1]; e++) {
      const u = inSources[e];
      if (e === removed.edge || u === removed.node || seen[u]) continue;
      seen[u] = 1;
      queue[size++] = u;
      count += counted[u];
    }
  }
  return count;
};

const MODULUS = 2_147_483_647;

/** A seeded random number generator (Park-Miller), so a failure can be replayed. */
const random = (seed: number) => {
  // Small seeds give small first draws, so the seed is spread out first.
  let state = (seed * 48_271) % MODULUS;
  return () => {
    state = (state * 16_807) % MODULUS;
    return state / MODULUS;
  };
};

const budget = eventLoopBudget(new AbortController().signal);

const KINDS = ['member_of', 'local_admin', 'credentials_left', 'can_assume'];

/** A random graph with cycles, self-loops and parallel links of different kinds. */
const randomGraph = (seed: number): { graph: Graph; counted: Uint8Array } => {
  const next = random(seed);
  const n = 8 + Math.floor(next() * 30);
  const edgeCount = Math.floor(n * (1 + next() * 2));
  const builder = graphBuilder();
  const isCounted = Array.from({ length: n }, () => (next() < 0.6 ? 1 : 0));
  for (let v = 0; v < n; v++) builder.intern(`n${v}`);
  const pick = () => Math.floor(next() * n);
  for (let k = 0; k < edgeCount; k++) {
    const from = pick();
    const to = pick();
    builder.addEdge(from, KINDS[Math.floor(next() * KINDS.length)], to);
    if (next() < 0.05) builder.addEdge(from, 'nested_in', to);
  }
  return { graph: builder.build(), counted: Uint8Array.from(isCounted) };
};

describe('chokePoints', () => {
  it('cuts off from every node and link what taking it away and walking again does', async () => {
    let checks = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const { graph, counted: some } = randomGraph(seed);
      const everyone = new Uint8Array(graph.nodeCount).fill(1);
      const d = dominatorBuffers(graph);
      const c = chokeBuffers(graph);
      for (const counted of [some, everyone]) {
        for (const root of [0, 1, graph.nodeCount - 1]) {
          await dominatorTree(graph, root, d, budget);
          const base = await cuts(graph, d, counted, c, budget);
          expect(base).toBe(countedReaching(graph, root, counted));

          for (let x = 0; x < graph.nodeCount; x++) {
            const i = d.num[x];
            if (x === root || i === -1) continue;
            const lost = base - countedReaching(graph, root, counted, { node: x }) - counted[x];
            expect(c.sub[i] - counted[x]).toBe(lost);
            checks++;
          }

          for (let a = 0; a < graph.nodeCount; a++) {
            for (let e = graph.inOffsets[a]; e < graph.inOffsets[a + 1]; e++) {
              const ia = d.num[a];
              const ib = d.num[graph.inSources[e]];
              const expected =
                ia !== -1 && ib > 0 && d.idom[ib] === ia && c.linkCut[ib] > 0 ? c.linkCut[ib] : 0;
              expect(base - countedReaching(graph, root, counted, { edge: e })).toBe(expected);
              checks++;
            }
          }
        }
      }
    }
    expect(checks).toBeGreaterThan(50_000);
  });

  it('keeps the top links and nodes a stable sort of them all would', async () => {
    const byCutOff = <T extends { cutOff: number }>(a: T, b: T) => b.cutOff - a.cutOff;
    for (let seed = 1; seed <= 300; seed++) {
      const { graph, counted } = randomGraph(seed);
      const d = dominatorBuffers(graph);
      const c = chokeBuffers(graph);
      await dominatorTree(graph, 0, d, budget);
      const { links, nodes, dominatingLinks } = await chokePoints(graph, d, counted, c, budget, 3);

      const allLinks = [];
      const allNodes = [];
      for (let i = 1; i < d.size; i++) {
        const fromId = graph.nameOf(d.vertex[i]);
        if (c.linkCut[i] > 0) allLinks.push({ fromId, cutOff: c.linkCut[i] });
        const cutOff = c.sub[i] - counted[d.vertex[i]];
        if (cutOff > 0 && c.linkCut[i] === 0 && cutOff > c.maxChildLink[i]) {
          allNodes.push({ nodeId: fromId, cutOff });
        }
      }
      expect(dominatingLinks).toBe(allLinks.length);
      expect(links.map(({ fromId, cutOff }) => ({ fromId, cutOff }))).toEqual(
        allLinks.sort(byCutOff).slice(0, 3)
      );
      expect(nodes).toEqual(allNodes.sort(byCutOff).slice(0, 3));
    }
  });

  it('reports a node only where it cuts off more than any one of its links', async () => {
    // a and b reach hub by their own links, and hub's one link to the seed cuts both off: a link
    // is the smaller fix, so hub isn't reported. x and y reach gate, whose two parallel links to
    // the seed can't be cut one at a time, so only removing gate cuts both off.
    const builder = graphBuilder();
    const edges = [
      ['a', 'member_of', 'hub'],
      ['b', 'member_of', 'hub'],
      ['hub', 'local_admin', 'jewel'],
      ['x', 'member_of', 'gate'],
      ['y', 'member_of', 'gate'],
      ['gate', 'local_admin', 'jewel'],
      ['gate', 'can_assume', 'jewel'],
    ];
    for (const [from, kind, to] of edges) {
      builder.addEdge(builder.intern(from), kind, builder.intern(to));
    }
    const graph = builder.build();
    const counted = new Uint8Array(graph.nodeCount);
    for (const id of ['a', 'b', 'x', 'y']) counted[graph.idOf(id) ?? -1] = 1;
    const d = dominatorBuffers(graph);
    await dominatorTree(graph, graph.idOf('jewel') ?? -1, d, budget);
    const result = await chokePoints(graph, d, counted, chokeBuffers(graph, d), budget);

    expect(result.countedReaching).toBe(4);
    expect(result.dominatingLinks).toBe(5);
    expect(result.links[0]).toEqual({
      fromId: 'hub',
      kind: 'local_admin',
      toId: 'jewel',
      cutOff: 2,
    });
    expect(
      result.links
        .slice(1)
        .map((l) => `${l.fromId}->${l.toId}:${l.cutOff}`)
        .sort()
    ).toEqual(['a->hub:1', 'b->hub:1', 'x->gate:1', 'y->gate:1']);
    expect(result.nodes).toEqual([{ nodeId: 'gate', cutOff: 2 }]);
  });
});
