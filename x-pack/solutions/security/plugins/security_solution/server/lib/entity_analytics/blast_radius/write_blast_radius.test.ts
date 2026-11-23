/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { eventLoopBudget, type NodeReach } from '@kbn/graph-algorithms';
import { percentilesByScore } from './write_blast_radius';

type Walk = Parameters<typeof percentilesByScore>[0];

const CROWN_JEWELS = 50;

/** A completed walk whose entities reach as many crown jewels as each score says, in pages. */
const walkOf = (scores: readonly number[]): Walk => {
  const nodes: NodeReach[] = scores.map((score, i) => ({
    nodeId: `entity-${i}`,
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

describe('percentilesByScore', () => {
  it('gives each entity the share of entities scoring the same or lower, as before', async () => {
    // Mostly low scores, as in a real run, with a few entities reaching many crown jewels.
    let state = 42;
    const next = () => (state = (state * 16_807) % 2_147_483_647) / 2_147_483_647;
    const scores = Array.from({ length: 25_000 }, () =>
      next() < 0.9 ? 1 + Math.floor(next() * 3) : 1 + Math.floor(next() * CROWN_JEWELS)
    );

    const percentiles = await percentilesByScore(
      walkOf(scores),
      eventLoopBudget(new AbortController().signal, 0)
    );

    const sorted = [...scores].sort((a, b) => a - b);
    const atOrBelow = (score: number) => sorted.filter((s) => s <= score).length;
    for (const score of new Set(scores)) {
      expect(percentiles[score]).toBe(Math.round((1000 * atOrBelow(score)) / scores.length) / 10);
    }
  });
});
