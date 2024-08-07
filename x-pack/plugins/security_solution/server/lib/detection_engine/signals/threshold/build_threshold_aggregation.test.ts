/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  buildThresholdMultiBucketAggregation,
  buildThresholdSingleBucketAggregation,
} from './build_threshold_aggregation';

describe('build_threshold_aggregation', () => {
  const timestampField = '@timestamp';

  describe('build_threshold_multi_bucket_aggregation', () => {
    const threshold = { field: ['host.name', 'source.ip'], value: 2 };
    it('Generates aggregation without cardinality', async () => {
      const aggs = buildThresholdMultiBucketAggregation({
        threshold,
        timestampField,
        sortKeys: undefined,
      });
      expect(aggs).toStrictEqual({
        thresholdTerms: {
          aggs: {
            count_check: {
              bucket_selector: {
                buckets_path: {
                  docCount: '_count',
                },
                script: 'params.docCount >= 2',
              },
            },
            max_timestamp: {
              max: {
                field: '@timestamp',
              },
            },
            min_timestamp: {
              min: {
                field: '@timestamp',
              },
            },
          },
          composite: {
            after: undefined,
            size: 10000,
            sources: [
              {
                'host.name': {
                  terms: {
                    field: 'host.name',
                  },
                },
              },
              {
                'source.ip': {
                  terms: {
                    field: 'source.ip',
                  },
                },
              },
            ],
          },
        },
      });
    });

    it('Generates aggregation with cardinality', async () => {
      const thresholdWithCardinality = {
        ...threshold,
        cardinality: [{ field: 'destination.ip', value: 2 }],
      };
      const aggs = buildThresholdMultiBucketAggregation({
        threshold: thresholdWithCardinality,
        timestampField,
        sortKeys: undefined,
      });
      expect(aggs).toStrictEqual({
        thresholdTerms: {
          aggs: {
            cardinality_check: {
              bucket_selector: {
                buckets_path: {
                  cardinalityCount: 'cardinality_count',
                },
                script: 'params.cardinalityCount >= 2',
              },
            },
            cardinality_count: {
              cardinality: {
                field: 'destination.ip',
              },
            },
            count_check: {
              bucket_selector: {
                buckets_path: {
                  docCount: '_count',
                },
                script: 'params.docCount >= 2',
              },
            },
            max_timestamp: {
              max: {
                field: '@timestamp',
              },
            },
            min_timestamp: {
              min: {
                field: '@timestamp',
              },
            },
          },
          composite: {
            after: undefined,
            size: 10000,
            sources: [
              {
                'host.name': {
                  terms: {
                    field: 'host.name',
                  },
                },
              },
              {
                'source.ip': {
                  terms: {
                    field: 'source.ip',
                  },
                },
              },
            ],
          },
        },
      });
    });
  });

  describe('build_threshold_single_bucket_aggregation', () => {
    const threshold = { field: [], value: 3 };

    it('Generates aggregation without cardinality', async () => {
      const aggs = buildThresholdSingleBucketAggregation({ threshold, timestampField });
      expect(aggs).toStrictEqual({
        max_timestamp: {
          max: {
            field: '@timestamp',
          },
        },
        min_timestamp: {
          min: {
            field: '@timestamp',
          },
        },
      });
    });

    it('Generates aggregation with cardinality', async () => {
      const thresholdWithCardinality = {
        ...threshold,
        cardinality: [{ field: 'destination.ip', value: 2 }],
      };
      const aggs = buildThresholdSingleBucketAggregation({
        threshold: thresholdWithCardinality,
        timestampField,
      });
      expect(aggs).toStrictEqual({
        cardinality_count: {
          cardinality: {
            field: 'destination.ip',
          },
        },
        max_timestamp: {
          max: {
            field: '@timestamp',
          },
        },
        min_timestamp: {
          min: {
            field: '@timestamp',
          },
        },
      });
    });
  });
});
