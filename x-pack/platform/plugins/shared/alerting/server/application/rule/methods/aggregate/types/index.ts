/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { AggregationsAggregationContainer } from '@elastic/elasticsearch/lib/api/types';
import type { TypeOf } from '@kbn/config-schema';
import type { KueryNode } from '@kbn/es-query';
import type { aggregateOptionsSchema } from '../schemas';
export type AggregateOptions = TypeOf<typeof aggregateOptionsSchema> & {
  // Adding filter as in schema it's defined as any instead of KueryNode
  filter?: string | KueryNode;
};

export interface AggregateParams<AggregationResult> {
  options?: AggregateOptions;
  aggs: Record<keyof AggregationResult, AggregationsAggregationContainer>;
}

export interface DefaultRuleAggregationParams {
  maxTags?: number;
}

export interface RuleAggregationFormattedResult {
  ruleExecutionStatus: Record<string, number>;
  ruleLastRunOutcome: Record<string, number>;
  ruleEnabledStatus: {
    enabled: number;
    disabled: number;
  };
  ruleMutedStatus: {
    muted: number;
    unmuted: number;
  };
  ruleSnoozedStatus: {
    snoozed: number;
  };
  ruleTags: string[];
}
