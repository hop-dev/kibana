/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/** A relationship held by an entity, pointing at a target entity. */
export interface Relationship {
  readonly entityId: string;
  readonly kind: string;
  readonly targetEntityId: string;
}

export interface RelationshipsReader {
  /** Every relationship whose target is one of these entities, a page at a time. */
  readonly relationshipsInto: (
    entityIds: readonly string[]
  ) => AsyncIterable<readonly Relationship[]>;
}

export interface RelationshipsReaderOptions {
  /** Only relationships of these kinds are read. */
  readonly kinds: readonly string[];
  /** Search requests the reader keeps in flight at once. */
  readonly requestsInFlight: number;
  readonly signal: AbortSignal;
  /** Called after each search, for callers that measure the reader. */
  readonly onSearch?: (search: RelationshipsSearch) => void;
}

/** One search the reader made. */
export interface RelationshipsSearch {
  /** Elasticsearch's own time for the search. */
  readonly tookMs: number;
  /** The request's round trip in Kibana, the response parsed: took plus network and parsing. */
  readonly roundTripMs: number;
  readonly relationships: number;
}
