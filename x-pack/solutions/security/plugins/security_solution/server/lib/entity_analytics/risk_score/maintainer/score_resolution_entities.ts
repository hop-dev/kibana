/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { ElasticsearchClient } from '@kbn/core/server';
import type { EntityUpdateClient } from '@kbn/entity-store/server';
import type { EntityType } from '../../../../../common/entity_analytics/types';
import type { WatchlistObject } from '../../../../../common/api/entity_analytics/watchlists/management/common.gen';
import { getResolutionCompositeQuery, getResolutionScoreESQL } from '../calculate_esql_risk_scores';
import { applyScoreModifiersFromEntities } from '../modifiers/apply_modifiers_from_entities';
import { fetchEntitiesByIds } from './utils/fetch_entities_by_ids';
import { buildResolutionModifierEntity } from './resolution_modifiers';
import { parseEsqlResolutionScoreRow } from './parse_esql_row';
import type { ScopedLogger } from './utils/with_log_context';
import type { ScoringSummaryBase } from './pipeline_types';

interface ScoreResolutionEntitiesParams {
  esClient: ElasticsearchClient;
  crudClient: EntityUpdateClient;
  logger: ScopedLogger;
  entityType: EntityType;
  alertsIndex: string;
  lookupIndex: string;
  pageSize: number;
  sampleSize: number;
  now: string;
  calculationRunId: string;
  watchlistConfigs: Map<string, WatchlistObject>;
}

export type ResolutionScoringSummary = ScoringSummaryBase;

export const scoreResolutionEntities = async ({
  esClient,
  crudClient,
  logger,
  entityType,
  alertsIndex,
  lookupIndex,
  pageSize,
  sampleSize,
  now,
  calculationRunId,
  watchlistConfigs,
}: ScoreResolutionEntitiesParams): Promise<ResolutionScoringSummary> => {
  let afterKey: Record<string, string> | undefined;
  let previousUpperBound: string | undefined;
  let pagesProcessed = 0;
  const scoredDocuments: ResolutionScoringSummary['scores'] = [];

  do {
    const compositeResponse = await esClient.search(
      getResolutionCompositeQuery(lookupIndex, pageSize, afterKey)
    );

    interface CompositeAgg {
      buckets: Array<{ key: Record<string, string> }>;
      after_key?: Record<string, string>;
    }

    const compositeAgg = (
      compositeResponse.aggregations as { by_resolution_target?: CompositeAgg } | undefined
    )?.by_resolution_target;
    const buckets = compositeAgg?.buckets ?? [];

    if (buckets.length === 0) {
      break;
    }

    pagesProcessed += 1;
    const upper = buckets[buckets.length - 1].key.resolution_target_id;
    afterKey = compositeAgg?.after_key;

    const query = getResolutionScoreESQL(
      entityType,
      { lower: previousUpperBound, upper },
      sampleSize,
      pageSize,
      alertsIndex,
      lookupIndex
    );

    const esqlResponse = await esClient.esql.query({ query });
    previousUpperBound = upper;
    const parsedScores = (esqlResponse.values ?? []).map(parseEsqlResolutionScoreRow(alertsIndex));

    if (parsedScores.length > 0) {
      const allMemberIds = new Set<string>();
      for (const score of parsedScores) {
        allMemberIds.add(score.resolution_target_id);
        for (const relatedEntity of score.related_entities) {
          allMemberIds.add(relatedEntity.entity_id);
        }
      }
      const memberEntities = await fetchEntitiesByIds({
        crudClient,
        entityIds: [...allMemberIds],
        logger,
        errorContext:
          'Error fetching entities for resolution modifier application. Resolution scoring will proceed without modifiers',
      });

      const mergedModifierEntities = new Map(
        parsedScores.map((score) => [
          score.resolution_target_id,
          buildResolutionModifierEntity({ score, memberEntities }),
        ])
      );

      const scoresForModifierPipeline = parsedScores.map((score) => ({
        entity_id: score.resolution_target_id,
        alert_count: score.alert_count,
        score: score.score,
        normalized_score: score.normalized_score,
        risk_inputs: score.risk_inputs,
      }));

      const modifiedScores = applyScoreModifiersFromEntities({
        now,
        identifierType: entityType,
        scoreType: 'resolution',
        calculationRunId,
        weights: [],
        page: {
          scores: scoresForModifierPipeline,
          identifierField: 'entity.id',
        },
        entities: mergedModifierEntities,
        watchlistConfigs,
      });

      for (const [index, modifiedScore] of modifiedScores.entries()) {
        scoredDocuments.push({
          ...modifiedScore,
          related_entities: parsedScores[index].related_entities,
        });
      }
    }
  } while (afterKey !== undefined);

  logger.debug(`resolution scoring produced ${scoredDocuments.length} documents`);

  return {
    pagesProcessed,
    scores: scoredDocuments,
  };
};
