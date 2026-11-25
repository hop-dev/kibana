/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** A directed edge of a kind, between two nodes with string ids. */
export interface Edge {
  readonly fromId: string;
  readonly kind: string;
  readonly toId: string;
}

/** Where a walk reads its edges from. */
export interface EdgeReader {
  /** Every edge into these nodes, a page at a time. */
  readonly edgesInto: (nodeIds: readonly string[]) => AsyncIterable<readonly Edge[]>;
}

/** A link that every path from the nodes it cuts off passes through. */
export interface ChokeLink {
  readonly fromId: string;
  readonly kind: string;
  readonly toId: string;
  /** Counted nodes that lose every path to the seed when the link is removed. */
  readonly cutOff: number;
}

/** A node that every path from the nodes it cuts off passes through. */
export interface ChokeNode {
  readonly nodeId: string;
  /** Counted nodes, itself excluded, that lose every path to the seed when it's removed. */
  readonly cutOff: number;
}

export interface ChokePoints {
  /** Counted nodes that reach the seed. */
  readonly countedReaching: number;
  /** Links that cut off at least one counted node. */
  readonly dominatingLinks: number;
  /** The links that cut off the most, most first. */
  readonly links: readonly ChokeLink[];
  /** The nodes that cut off more than any one of their links, most first. */
  readonly nodes: readonly ChokeNode[];
}

export interface SeedReach {
  readonly seedId: string;
  /** Edges into every node that reaches the seed: what a walk from this seed alone would read. */
  readonly edgesRead: number;
  /** Nodes that reach the seed, by hops: reachedByHops[0] is the nodes one hop away. */
  readonly reachedByHops: readonly number[];
  readonly chokePoints: ChokePoints;
}

export interface NodeReach {
  readonly nodeId: string;
  /** Each seed the node reaches, with its hops to it and the next node on one shortest path. */
  readonly seeds: ReadonlyArray<{
    readonly seedId: string;
    readonly hops: number;
    readonly nextNodeId: string;
  }>;
}

/** A node that reaches at least one seed, and how many it reaches. */
export interface NodeSeedCount {
  readonly nodeId: string;
  readonly seedsReached: number;
}

export type MultiSeedWalkResult =
  | { readonly outcome: 'cap'; readonly edgesRead: number; readonly hops: number }
  | {
      readonly outcome: 'completed';
      readonly edgesRead: number;
      readonly hops: number;
      /** Nodes that reach at least one seed, the seeds themselves excluded. */
      readonly nodesReached: number;
      readonly seeds: readonly SeedReach[];
      /** Every node that reaches a seed, a page at a time. */
      readonly nodes: () => Iterable<readonly NodeReach[]>;
      /** Every node that reaches a seed, with only how many it reaches: cheaper than nodes(). */
      readonly nodeSeedCounts: () => Iterable<NodeSeedCount>;
    };

/** One round of reads, reported as it ends. */
/**
 * How long one seed's share of the compute took, in seconds. Wall time, so it includes the time
 * the compute lets the event loop run other work.
 */
export interface SeedCompute {
  readonly seedId: string;
  /** Walking back from the seed over the built graph and counting what it reaches. */
  readonly reachSeconds: number;
  readonly dominatorsSeconds: number;
  readonly chokePointsSeconds: number;
  /** Walking back again to record each node's hops and next node to the seed. */
  readonly nodeReachSeconds: number;
}

export interface WalkHop {
  /** 1 for the edges into the seeds, 2 for the edges into what those reached, and so on. */
  readonly hop: number;
  /** Nodes whose edges this hop read. */
  readonly frontierSize: number;
  /** Edges read so far, this hop included. */
  readonly edgesRead: number;
}

export interface MultiSeedWalkOptions {
  /** Stop reading, and return the cap outcome, once more edges than this have been read. */
  readonly maxEdgesRead: number;
  readonly signal: AbortSignal;
  /** Which nodes choke points count as cut off. Every node when omitted. */
  readonly isCounted?: (nodeId: string) => boolean;
  /** Called after each hop's reads. */
  readonly onHop?: (hop: WalkHop) => void;
  /** Called with each seed's compute times, once every seed's are known. For measurement. */
  readonly onSeedComputed?: (compute: SeedCompute) => void;
  /** Choke links and nodes kept per seed. 10 when omitted. */
  readonly topChokePoints?: number;
  /** Nodes in each page nodes() hands out. 1,000 when omitted. */
  readonly nodesPageSize?: number;
}
