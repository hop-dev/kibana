/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { eventLoopBudget } from './event_loop_budget';
import { graphBuilder, type Graph } from './graph';
import { reverseWalk, walkBuffers } from './walk';

const budget = eventLoopBudget(new AbortController().signal);

const graphOf = (edges: ReadonlyArray<readonly [string, string, string]>): Graph => {
  const builder = graphBuilder();
  for (const [from, kind, to] of edges) {
    builder.addEdge(builder.intern(from), kind, builder.intern(to));
  }
  builder.intern('lonely-seed');
  return builder.build();
};

// Arrows point the way an attacker moves.
//
//   alice -member_of-> eng -sso_to_role-> oncall -bucket_policy-> pii
//   bob   -member_of-> eng
//   dave  -local_admin-> jump -credentials_left-> admin -member_of-> domain-admins
const EDGES = [
  ['alice', 'member_of', 'eng'],
  ['bob', 'member_of', 'eng'],
  ['eng', 'sso_to_role', 'oncall'],
  ['oncall', 'bucket_policy', 'pii'],
  ['dave', 'local_admin', 'jump'],
  ['jump', 'credentials_left', 'admin'],
  ['admin', 'member_of', 'domain-admins'],
] as const;

describe('reverseWalk', () => {
  it('gives hops and next node for everyone who can reach the seed', async () => {
    const graph = graphOf(EDGES);
    const buffers = walkBuffers(graph);
    const id = (name: string) => graph.idOf(name) ?? -1;
    const route = (name: string) => [buffers.hops[id(name)], graph.nameOf(buffers.next[id(name)])];

    expect(await reverseWalk(graph, id('pii'), buffers, budget)).toEqual({
      reached: 4,
      edgesRead: 4,
      maxHops: 3,
    });
    expect(route('oncall')).toEqual([1, 'pii']);
    expect(route('eng')).toEqual([2, 'oncall']);
    expect(route('alice')).toEqual([3, 'eng']);
    expect(route('bob')).toEqual([3, 'eng']);
    expect(buffers.hops[id('dave')]).toBe(-1);
  });

  it('reuses its buffers: a walk forgets the one before it', async () => {
    const graph = graphOf(EDGES);
    const buffers = walkBuffers(graph);
    const id = (name: string) => graph.idOf(name) ?? -1;
    await reverseWalk(graph, id('pii'), buffers, budget);

    expect(await reverseWalk(graph, id('domain-admins'), buffers, budget)).toEqual({
      reached: 3,
      edgesRead: 3,
      maxHops: 3,
    });
    expect(buffers.hops[id('alice')]).toBe(-1);
    expect(buffers.next[id('alice')]).toBe(-1);
    expect(buffers.hops[id('dave')]).toBe(3);
    expect(await reverseWalk(graph, id('lonely-seed'), buffers, budget)).toEqual({
      reached: 0,
      edgesRead: 0,
      maxHops: 0,
    });
  });

  it('reaches from several seeds what the single walks reach together, reading each edge once', async () => {
    const graph = graphOf([
      ['a', 'member_of', 'g1'],
      ['b', 'member_of', 'g2'],
      ['c', 'member_of', 'g1'],
      ['c', 'member_of', 'g2'],
      ['d', 'member_of', 'c'],
      ['g1', 'nested_in', 'g2'],
    ]);
    const buffers = walkBuffers(graph);
    const both = await reverseWalk(
      graph,
      ['g1', 'g2'].map((name) => graph.idOf(name) ?? -1),
      buffers,
      budget
    );
    const reached = Array.from(buffers.order.subarray(0, buffers.size), (v) => graph.nameOf(v));

    expect(reached.sort()).toEqual(['a', 'b', 'c', 'd', 'g1', 'g2']);
    expect(both).toEqual({ reached: 4, edgesRead: 6, maxHops: 2 });
  });
});
