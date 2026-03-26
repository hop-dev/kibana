/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { elasticsearchServiceMock } from '@kbn/core/server/mocks';
import type { Logger } from '@kbn/core/server';
import type { EntityUpdateClient } from '@kbn/entity-store/server';
import { calculateBaseEntityScores } from './score_base_entities';

describe('calculateBaseEntityScores pagination bounds', () => {
  it('uses previous page upper bound as the next lower bound', async () => {
    const esClient = elasticsearchServiceMock.createScopedClusterClient().asCurrentUser;
    const logger = { debug: jest.fn(), warn: jest.fn() } as unknown as Logger;
    const crudClient = {
      listEntities: jest.fn(),
      updateEntity: jest.fn(),
      bulkUpdateEntity: jest.fn(),
    } as unknown as EntityUpdateClient;

    (esClient.search as jest.Mock)
      .mockResolvedValueOnce({
        aggregations: {
          by_entity_id: {
            buckets: [{ key: { entity_id: 'host:a' } }, { key: { entity_id: 'host:b' } }],
            after_key: { entity_id: 'host:b' },
          },
        },
      })
      .mockResolvedValueOnce({
        aggregations: {
          by_entity_id: {
            buckets: [{ key: { entity_id: 'host:c' } }, { key: { entity_id: 'host:d' } }],
          },
        },
      });

    // Empty score rows are enough to validate query bound generation.
    (esClient.esql.query as jest.Mock).mockResolvedValue({ values: [] });

    const pages = [];
    for await (const page of calculateBaseEntityScores({
      esClient,
      crudClient,
      logger,
      entityType: 'host',
      alertFilters: [],
      alertsIndex: '.alerts-security.alerts-default',
      pageSize: 2,
      sampleSize: 100,
      now: '2026-01-01T00:00:00.000Z',
      calculationRunId: 'run-id-1',
      watchlistConfigs: new Map(),
    })) {
      pages.push(page);
    }

    // No rows yielded because ESQL returned empty values; we still validate bounds.
    expect(pages).toEqual([]);
    expect(esClient.esql.query).toHaveBeenCalledTimes(2);

    const firstQuery = (esClient.esql.query as jest.Mock).mock.calls[0][0].query as string;
    const secondQuery = (esClient.esql.query as jest.Mock).mock.calls[1][0].query as string;

    // First page should only be upper-bounded to avoid skipping the first entity.
    expect(firstQuery).toContain('entity_id <= "host:b"');
    expect(firstQuery).not.toContain('entity_id > "host:a"');

    // Second page should advance from previous page upper bound.
    expect(secondQuery).toContain('entity_id > "host:b"');
    expect(secondQuery).toContain('entity_id <= "host:d"');
  });
});
