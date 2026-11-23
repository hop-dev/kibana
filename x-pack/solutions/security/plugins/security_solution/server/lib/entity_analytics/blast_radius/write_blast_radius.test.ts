/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { eventLoopBudget, type NodeReach } from '@kbn/graph-algorithms';
import { percentilesByType } from './write_blast_radius';

type Walk = Parameters<typeof percentilesByType>[0];

const CROWN_JEWELS = 50;
/** An EUID of each entity type: user, host and service carry their type, generic ones don't. */
const ID_PREFIXES = { user: 'user:', host: 'host:', service: 'service:', generic: 'group:' };

/** A completed walk whose entities reach as many crown jewels as each score says, in pages. */
const walkOf = (entities: ReadonlyArray<{ nodeId: string; score: number }>): Walk => {
  const nodes: NodeReach[] = entities.map(({ nodeId, score }) => ({
    nodeId,
    seeds: Array.from({ length: score }, (_, s) => ({
      seedId: `jewel-${s}`,
      hops: 1,
      nextNodeId: `jewel-${s}`,
    })),
  }));
  return {
    outcome: 'completed',
    edgesRead: 0,
    hops: 1,
    nodesReached: nodes.length,
    seeds: Array.from({ length: CROWN_JEWELS }, (_, s) => ({
      seedId: `jewel-${s}`,
      edgesRead: 0,
      reachedByHops: [],
      chokePoints: { countedReaching: 0, dominatingLinks: 0, links: [], nodes: [] },
    })),
    *nodes() {
      for (let at = 0; at < nodes.length; at += 1_000) yield nodes.slice(at, at + 1_000);
    },
  };
};

describe('percentilesByType', () => {
  it('gives each entity the share of entities of its type scoring strictly lower', async () => {
    // Mostly score 1, as in a real run, with a few entities reaching many crown jewels.
    let state = 42;
    const next = () => (state = (state * 16_807) % 2_147_483_647) / 2_147_483_647;
    const types = Object.keys(ID_PREFIXES) as Array<keyof typeof ID_PREFIXES>;
    const entities = Array.from({ length: 5_000 }, (_, i) => {
      const type = types[Math.floor(next() * types.length)];
      const score = next() < 0.95 ? 1 : 1 + Math.floor(next() * CROWN_JEWELS);
      return { type, nodeId: `${ID_PREFIXES[type]}entity-${i}`, score };
    });
    const walk = walkOf(entities);

    const percentileOf = await percentilesByType(
      walk,
      eventLoopBudget(new AbortController().signal, 0)
    );

    const nodes = [...walk.nodes()].flat();
    for (const [i, { type, score }] of entities.entries()) {
      const peers = entities.filter((other) => other.type === type);
      const below = peers.filter((other) => other.score < score).length;
      expect(percentileOf(nodes[i])).toBe(Math.round((1000 * below) / peers.length) / 10);
    }
    expect(percentileOf(nodes[entities.findIndex(({ score }) => score === 1)])).toBe(0);
  });
});
