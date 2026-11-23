/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { dominatorBuffers, dominatorTree } from './dominators';
import { eventLoopBudget } from './event_loop_budget';
import { graphBuilder } from './graph';

/** A chain of n nodes into the seed n0, so the dominator tree is one long loop. */
const chain = (n: number) => {
  const builder = graphBuilder();
  for (let v = 1; v < n; v++) {
    builder.addEdge(builder.intern(`n${v}`), 'member_of', builder.intern(`n${v - 1}`));
  }
  return builder.build();
};

describe('eventLoopBudget', () => {
  it('lets the event loop run in the middle of long compute once the budget is spent', async () => {
    const graph = chain(10_000);
    let ranDuringCompute = false;
    let computing = true;
    setImmediate(() => {
      ranDuringCompute = computing;
    });

    await dominatorTree(
      graph,
      0,
      dominatorBuffers(graph),
      eventLoopBudget(new AbortController().signal, 0)
    );
    computing = false;

    expect(ranDuringCompute).toBe(true);
  });

  it('stops at the next yield once the work is aborted', async () => {
    const controller = new AbortController();
    const graph = chain(10_000);
    const compute = dominatorTree(
      graph,
      0,
      dominatorBuffers(graph),
      eventLoopBudget(controller.signal, 0)
    );
    controller.abort();

    await expect(compute).rejects.toThrow();
  });
});
