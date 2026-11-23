/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { SortResults } from '@elastic/elasticsearch/lib/api/types';
import type { ElasticsearchClient } from '@kbn/core/server';
import type {
  Relationship,
  RelationshipsReader,
  RelationshipsReaderOptions,
} from '../../domain/relationships/types';

// The edges index: one document per relationship, `src` holding it, `kind` and `dst` its target.
// Read with Query DSL and search_after, from one point in time for the reader's life: each chunk
// of target ids is paged through to its end, whatever the row limits of ES|QL.

/** A terms query's most terms (index.max_terms_count). */
const CHUNK_SIZE = 65_536;
/** Hits a page may return at default settings (index.max_result_window). */
const PAGE_SIZE = 10_000;
const KEEP_ALIVE = '5m';

/** The edges index of a space. Its template and install are still to come: today a generator creates it. */
export const getEdgesIndexName = (namespace: string): string => `entities-edges-${namespace}`;

export class EdgesIndexNotFoundError extends Error {
  constructor(index: string) {
    super(`The edges index ${index} doesn't exist, so there are no relationships to read`);
  }
}

interface EdgeFields {
  readonly src?: readonly string[];
  readonly kind?: readonly string[];
  readonly dst?: readonly string[];
}

interface PageState {
  readonly chunk: readonly string[];
  readonly searchAfter?: SortResults;
}

interface PageResult {
  readonly state: PageState;
  readonly relationships: readonly Relationship[];
  readonly next?: PageState;
}

const isNotFound = (error: unknown): boolean =>
  (error as { meta?: { statusCode?: number } })?.meta?.statusCode === 404;

/**
 * Opens a reader over the space's edges index, with one point in time held until close is
 * called. Throws EdgesIndexNotFoundError when the index doesn't exist.
 */
export const openEdgesReader = async (
  esClient: ElasticsearchClient,
  namespace: string,
  { kinds, requestsInFlight, signal, onSearch }: RelationshipsReaderOptions
): Promise<{ reader: RelationshipsReader; close: () => Promise<void> }> => {
  const index = getEdgesIndexName(namespace);
  let pitId: string;
  try {
    ({ id: pitId } = await esClient.openPointInTime({ index, keep_alive: KEEP_ALIVE }, { signal }));
  } catch (error) {
    if (isNotFound(error)) throw new EdgesIndexNotFoundError(index);
    throw error;
  }

  const readPage = async (state: PageState): Promise<PageResult> => {
    const sentAt = performance.now();
    const response = await esClient.search<unknown>(
      {
        size: PAGE_SIZE,
        track_total_hits: false,
        _source: false,
        docvalue_fields: ['src', 'kind', 'dst'],
        query: {
          bool: {
            filter: [{ terms: { kind: [...kinds] } }, { terms: { dst: [...state.chunk] } }],
          },
        },
        pit: { id: pitId, keep_alive: KEEP_ALIVE },
        sort: ['_shard_doc'],
        ...(state.searchAfter && { search_after: state.searchAfter }),
      },
      { signal }
    );
    pitId = response.pit_id ?? pitId;
    const { hits } = response.hits;
    onSearch?.({
      tookMs: response.took,
      roundTripMs: performance.now() - sentAt,
      relationships: hits.length,
    });
    const relationships = hits.map(({ fields }) => {
      const { src, kind, dst } = (fields ?? {}) as EdgeFields;
      return { entityId: src?.[0] ?? '', kind: kind?.[0] ?? '', targetEntityId: dst?.[0] ?? '' };
    });
    const last = hits[hits.length - 1];
    return {
      state,
      relationships,
      next:
        hits.length === PAGE_SIZE && last?.sort ? { ...state, searchAfter: last.sort } : undefined,
    };
  };

  const relationshipsInto = async function* (
    entityIds: readonly string[]
  ): AsyncGenerator<readonly Relationship[]> {
    const chunks: Array<readonly string[]> = [];
    for (let at = 0; at < entityIds.length; at += CHUNK_SIZE) {
      chunks.push(entityIds.slice(at, at + CHUNK_SIZE));
    }
    // Up to requestsInFlight pages are read at once. A chunk's next page is asked for as soon as
    // its last one arrives, before that page is handed on.
    const inFlight = new Map<number, Promise<{ slot: number; page: PageResult }>>();
    let nextChunk = 0;
    let nextSlot = 0;
    const start = (state: PageState): void => {
      const slot = nextSlot++;
      inFlight.set(
        slot,
        readPage(state).then((page) => ({ slot, page }))
      );
    };
    while (nextChunk < chunks.length && inFlight.size < requestsInFlight) {
      start({ chunk: chunks[nextChunk++] });
    }
    try {
      while (inFlight.size > 0) {
        const { slot, page } = await Promise.race(inFlight.values());
        inFlight.delete(slot);
        if (page.next) start(page.next);
        else if (nextChunk < chunks.length) start({ chunk: chunks[nextChunk++] });
        yield page.relationships;
      }
    } finally {
      // A caller that stops early leaves requests in flight. Let them settle before returning.
      await Promise.allSettled(inFlight.values());
    }
  };

  return {
    reader: { relationshipsInto },
    close: async () => {
      try {
        await esClient.closePointInTime({ id: pitId });
      } catch (error) {
        // A point in time left idle past its keep alive has already closed itself.
        if (!isNotFound(error)) throw error;
      }
    },
  };
};
