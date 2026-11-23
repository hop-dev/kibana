/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

// Long compute shares Kibana's event loop: loops check the budget as they go, and once about 50 ms
// have passed since the last yield, they let the event loop run before carrying on.

const BUDGET_MS = 50;
/** Checks between reads of the clock, so a check in a tight loop costs next to nothing. */
const CHECKS_PER_CLOCK_READ = 1_024;

export interface EventLoopBudget {
  /** True once the budget is spent. Reads the clock only every so many checks. */
  readonly spent: () => boolean;
  /** Lets the event loop run and starts a new budget, then stops if the work was aborted. */
  readonly yield: () => Promise<void>;
}

/** A budget for one piece of work, used as `if (budget.spent()) await budget.yield();`. */
export const eventLoopBudget = (signal: AbortSignal, budgetMs = BUDGET_MS): EventLoopBudget => {
  let since = performance.now();
  let checks = 0;
  return {
    spent: () => {
      if (++checks < CHECKS_PER_CLOCK_READ) return false;
      checks = 0;
      return performance.now() - since >= budgetMs;
    },
    yield: async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      since = performance.now();
      checks = 0;
      signal.throwIfAborted();
    },
  };
};
