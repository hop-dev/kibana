/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { elasticsearchServiceMock } from '@kbn/core/server/mocks';
import type { ElasticsearchClient } from '@kbn/core/server';
import { EntityType } from '../../../../common/entity_analytics/types';
import {
  TempEntityStoreV2Writer,
  getEntityStoreV2UpdatesDataStreamName,
} from './temp_entity_store_v2_writer';

describe('getEntityStoreV2UpdatesDataStreamName', () => {
  it('returns the v2 updates data stream name for the given namespace', () => {
    expect(getEntityStoreV2UpdatesDataStreamName('default')).toBe(
      '.entities.v2.updates.security_default'
    );
    expect(getEntityStoreV2UpdatesDataStreamName('space-1')).toBe(
      '.entities.v2.updates.security_space-1'
    );
  });
});

describe('TempEntityStoreV2Writer', () => {
  let esClientMock: ElasticsearchClient;

  beforeEach(() => {
    esClientMock = elasticsearchServiceMock.createScopedClusterClient().asCurrentUser;
  });

  describe('upsertEntitiesBulk', () => {
    it('returns zeros when given an empty array', async () => {
      const writer = new TempEntityStoreV2Writer(esClientMock, 'default');
      const result = await writer.upsertEntitiesBulk([]);
      expect(result).toEqual({ errors: [], docs_written: 0 });
      expect(esClientMock.bulk).not.toHaveBeenCalled();
    });

    it('sends bulk index operations to the v2 updates data stream', async () => {
      (esClientMock.bulk as jest.Mock).mockResolvedValue({
        errors: false,
        items: [
          { index: { _index: '.entities.v2.updates.security_default', status: 201 } },
          { index: { _index: '.entities.v2.updates.security_default', status: 201 } },
        ],
      });

      const writer = new TempEntityStoreV2Writer(esClientMock, 'default');
      const objects = [
        {
          type: EntityType.host,
          document: {
            '@timestamp': '2024-01-15T12:00:00Z',
            host: {
              entity: { id: 'host:abc123' },
              risk: {
                calculated_score: 50,
                calculated_score_norm: 25,
                calculated_level: 'Medium',
              },
            },
          },
        },
        {
          type: EntityType.user,
          document: {
            '@timestamp': '2024-01-15T12:00:00Z',
            user: {
              entity: { id: 'user:alice' },
              risk: {
                calculated_score: 30,
                calculated_score_norm: 15,
                calculated_level: 'Low',
              },
            },
          },
        },
      ];

      const result = await writer.upsertEntitiesBulk(objects);

      expect(result).toEqual({ errors: [], docs_written: 2 });
      expect(esClientMock.bulk).toHaveBeenCalledTimes(1);
      const [{ operations, refresh }] = (esClientMock.bulk as jest.Mock).mock.calls[0];
      expect(operations).toHaveLength(4); // 2 index ops + 2 documents
      expect(operations[0]).toEqual({ index: { _index: '.entities.v2.updates.security_default' } });
      expect(operations[1]).toEqual(objects[0].document);
      expect(operations[2]).toEqual({ index: { _index: '.entities.v2.updates.security_default' } });
      expect(operations[3]).toEqual(objects[1].document);
      expect(refresh).toBe(false);
    });

    it('passes refresh option when provided', async () => {
      (esClientMock.bulk as jest.Mock).mockResolvedValue({
        errors: false,
        items: [{ index: { status: 201 } }],
      });

      const writer = new TempEntityStoreV2Writer(esClientMock, 'default');
      await writer.upsertEntitiesBulk(
        [
          {
            type: EntityType.host,
            document: { '@timestamp': '2024-01-15T12:00:00Z', host: { entity: { id: 'host:1' } } },
          },
        ],
        { refresh: 'wait_for' }
      );

      const [[{ refresh }]] = (esClientMock.bulk as jest.Mock).mock.calls;
      expect(refresh).toBe('wait_for');
    });

    it('returns errors and docs_written from bulk response', async () => {
      (esClientMock.bulk as jest.Mock).mockResolvedValue({
        errors: true,
        items: [
          { index: { _index: '.entities.v2.updates.security_default', status: 201 } },
          { index: { error: { reason: 'mapping conflict' }, status: 400 } },
        ],
      });

      const writer = new TempEntityStoreV2Writer(esClientMock, 'default');
      const result = await writer.upsertEntitiesBulk([
        {
          type: EntityType.host,
          document: { '@timestamp': '2024-01-15T12:00:00Z', host: { entity: { id: 'host:1' } } },
        },
        {
          type: EntityType.host,
          document: { '@timestamp': '2024-01-15T12:00:00Z', host: { entity: { id: 'host:2' } } },
        },
      ]);

      expect(result.docs_written).toBe(1);
      expect(result.errors).toContain('mapping conflict');
    });

    it('returns errors and zero docs_written when bulk throws', async () => {
      (esClientMock.bulk as jest.Mock).mockRejectedValue(new Error('Connection refused'));

      const writer = new TempEntityStoreV2Writer(esClientMock, 'default');
      const result = await writer.upsertEntitiesBulk([
        {
          type: EntityType.generic,
          document: {
            '@timestamp': '2024-01-15T12:00:00Z',
            entity: { id: 'generic:xyz', risk: { calculated_score: 10, calculated_score_norm: 5, calculated_level: 'Low' } },
          },
        },
      ]);

      expect(result).toEqual({ errors: ['Connection refused'], docs_written: 0 });
    });
  });
});
