/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { AuditLogger } from '@kbn/security-plugin-types-server';
import type { RegisterEntityMaintainerConfig } from '@kbn/entity-store/server';
import { ProductFeatureKey } from '@kbn/security-solution-features/keys';
import type { Entity } from '@kbn/entity-store/common';
import type { EntityAnalyticsRoutesDeps } from '../../types';
import type { ExperimentalFeatures } from '../../../../../common';
import { DEFAULT_RISK_SCORE_PAGE_SIZE } from '../../../../../common/constants';
import {
  getEntityAnalyticsEntityTypes,
  getAlertsIndex,
} from '../../../../../common/entity_analytics/utils';
import type { ProductFeaturesService } from '../../../product_features_service/product_features_service';
import { RiskScoreDataClient } from '../risk_score_data_client';
import {
  getEuidCompositeQuery,
  getBaseScoreESQL,
  buildBaseScoreRiskScoreBucket,
} from '../calculate_esql_risk_scores';
import { applyScoreModifiersFromEntities } from '../modifiers/apply_modifiers_from_entities';
import { filterFromRange } from '../helpers';
import {
  initSavedObjects,
  getConfiguration,
} from '../../risk_engine/utils/saved_object_configuration';
import { buildScopedInternalSavedObjectsClientUnsafe, convertRangeToISO } from '../tasks/helpers';
import { getIsIdBasedRiskScoringEnabled } from '../is_id_based_risk_scoring_enabled';
import { persistRiskScoresToEntityStore } from '../persist_risk_scores_to_entity_store';
import { WatchlistConfigClient } from '../../watchlists/management/watchlist_config';
import type { WatchlistObject } from '../../../../../common/api/entity_analytics/watchlists/management/common.gen';

const fetchWatchlistConfigs = async (
  params: ConstructorParameters<typeof WatchlistConfigClient>[0]
): Promise<Map<string, WatchlistObject>> => {
  try {
    const watchlistClient = new WatchlistConfigClient(params);
    const watchlists = await watchlistClient.list();
    return new Map(
      watchlists
        .filter((w): w is WatchlistObject & { id: string } => w.id != null)
        .map((w) => [w.id, w])
    );
  } catch (error) {
    params.logger.warn(
      `Error fetching watchlist configs: ${error}. Scoring will proceed without watchlist modifiers.`
    );
    return new Map();
  }
};

export interface RiskScoreMaintainerDeps {
  getStartServices: EntityAnalyticsRoutesDeps['getStartServices'];
  kibanaVersion: string;
  logger: Logger;
  auditLogger: AuditLogger | undefined;
  experimentalFeatures: ExperimentalFeatures;
  productFeaturesService: ProductFeaturesService;
}

type RiskScoreMaintainerConfig = Pick<RegisterEntityMaintainerConfig, 'setup' | 'run'>;

export const createRiskScoreMaintainer = ({
  getStartServices,
  kibanaVersion,
  logger,
  auditLogger,
  experimentalFeatures,
  productFeaturesService,
}: RiskScoreMaintainerDeps): RiskScoreMaintainerConfig => ({
  setup: async ({ status }) => {
    const namespace = status.metadata.namespace;
    const [coreStart] = await getStartServices();
    const esClient = coreStart.elasticsearch.client.asInternalUser;
    const soClient = buildScopedInternalSavedObjectsClientUnsafe({ coreStart, namespace });

    const riskScoreDataClient = new RiskScoreDataClient({
      logger,
      kibanaVersion,
      esClient,
      namespace,
      soClient,
      auditLogger,
    });

    logger.debug(`Initializing risk score maintainer saved objects for namespace "${namespace}"`);
    await initSavedObjects({ savedObjectsClient: soClient, namespace });
    logger.debug(`Initializing risk score maintainer data client for namespace "${namespace}"`);
    await riskScoreDataClient.init();

    logger.info(`Risk score maintainer setup completed for namespace "${namespace}"`);
    return status.state;
  },
  run: async ({ status, crudClient }) => {
    const [coreStart, pluginsStart] = await getStartServices();
    const license = await pluginsStart.licensing.getLicense();

    // Advanced insights requires a platinum license (ESS) or feature enablement (Serverless).
    // In Serverless, hasAtLeast('platinum') is always true; in ESS, isEnabled() is always true.
    // Both conditions must be met to correctly gate access in either environment.
    const isFeatureEnabled = productFeaturesService.isEnabled(ProductFeatureKey.advancedInsights);
    const hasPlatinumLicense = license.hasAtLeast('platinum');

    if (!isFeatureEnabled || !hasPlatinumLicense) {
      logger.debug(
        'Risk score maintainer run skipped due to insufficient license or feature disabled'
      );
      return status.state;
    }

    const namespace = status.metadata.namespace;
    const esClient = coreStart.elasticsearch.client.asInternalUser;
    const soClient = buildScopedInternalSavedObjectsClientUnsafe({ coreStart, namespace });

    const riskScoreDataClient = new RiskScoreDataClient({
      logger,
      kibanaVersion,
      esClient,
      namespace,
      soClient,
      auditLogger,
    });

    const configuration = await getConfiguration({ savedObjectsClient: soClient });
    const dataViewId = configuration?.dataViewId ?? getAlertsIndex(namespace);
    const { index: alertsIndex } = await riskScoreDataClient.getRiskInputsIndex({ dataViewId });

    const range = convertRangeToISO(configuration.range);
    const alertFilters: import('@elastic/elasticsearch/lib/api/types').QueryDslQueryContainer[] = [
      filterFromRange(range),
    ];
    if (configuration.excludeAlertStatuses && configuration.excludeAlertStatuses.length > 0) {
      alertFilters.push({
        bool: {
          must_not: {
            terms: { 'kibana.alert.workflow_status': configuration.excludeAlertStatuses },
          },
        },
      });
    }
    if (configuration.excludeAlertTags && configuration.excludeAlertTags.length > 0) {
      alertFilters.push({
        bool: {
          must_not: { terms: { 'kibana.alert.workflow_tags': configuration.excludeAlertTags } },
        },
      });
    }

    const uiSettingsClient = coreStart.uiSettings.asScopedToClient(soClient);
    const idBasedRiskScoringEnabled = await getIsIdBasedRiskScoringEnabled(uiSettingsClient);

    // Fetch watchlist configs once per run and build a lookup map by SO ID.
    const watchlistConfigs = await fetchWatchlistConfigs({ soClient, esClient, namespace, logger });

    const writer = await riskScoreDataClient.getWriter({ namespace });
    const now = new Date().toISOString();
    const sampleSize = 10_000;
    const pageSize = DEFAULT_RISK_SCORE_PAGE_SIZE;

    for (const entityType of getEntityAnalyticsEntityTypes()) {
      let afterKey: Record<string, string> | undefined;

      do {
        // Step 1: Paginate entity IDs via composite agg using Painless EUID runtime mapping.
        const compositeResponse = await esClient.search(
          getEuidCompositeQuery(entityType, alertFilters, {
            index: alertsIndex,
            pageSize,
            afterKey,
          })
        );

        interface CompositeAgg {
          buckets: Array<{ key: Record<string, string> }>;
          after_key?: Record<string, string>;
        }
        const compositeAgg = (
          compositeResponse.aggregations as { by_entity_id?: CompositeAgg } | undefined
        )?.by_entity_id;
        const buckets = compositeAgg?.buckets ?? [];

        if (buckets.length === 0) break;

        const entityIdField = `${entityType}_id`;
        const lower = buckets[0].key[entityIdField];
        const upper = buckets[buckets.length - 1].key[entityIdField];
        afterKey = compositeAgg?.after_key;

        // Step 2: Score the page with ES|QL.
        const esqlResponse = await esClient.esql.query({
          query: getBaseScoreESQL(entityType, { lower, upper }, sampleSize, pageSize, alertsIndex),
          format: 'array',
        });

        interface EsqlArrayResponse {
          values: Array<Array<unknown>>;
        }
        const rows = ((esqlResponse as unknown as EsqlArrayResponse).values ?? []).map(
          buildBaseScoreRiskScoreBucket(entityType, alertsIndex)
        );

        if (rows.length > 0) {
          // Step 3: Fetch entities from the Entity Store for modifier application.
          const euidValues = rows.map((row) => row.key[entityIdField]);
          let entityMap = new Map<string, Entity>();

          try {
            let searchAfter: Array<string | number> | undefined;
            do {
              const { entities: batch, nextSearchAfter } = await crudClient.listEntities({
                filter: { terms: { 'entity.id': euidValues } },
                size: euidValues.length,
                searchAfter,
              });
              for (const entity of batch) {
                if (entity.entity?.id) {
                  entityMap.set(entity.entity.id, entity);
                }
              }
              searchAfter = nextSearchAfter;
            } while (searchAfter !== undefined);
          } catch (error) {
            logger.warn(
              `Error fetching entities for modifier application: ${error}. Scoring will proceed without modifiers.`
            );
            entityMap = new Map();
          }

          // Step 4: Apply score modifiers from entity documents.
          const scores = applyScoreModifiersFromEntities({
            now,
            identifierType: entityType,
            weights: [],
            page: {
              buckets: rows,
              identifierField: entityIdField,
            },
            entities: entityMap,
            watchlistConfigs,
          });

          // Step 5: Persist risk scores.
          await writer.bulk({ [entityType]: scores });

          // Step 6: Dual-write to entity store (update existing entities only).
          if (idBasedRiskScoringEnabled) {
            const entityStoreErrors = await persistRiskScoresToEntityStore({
              crudClient,
              logger,
              scores: { [entityType]: scores },
            });
            if (entityStoreErrors.length > 0) {
              logger.warn(
                `Entity store dual-write had ${
                  entityStoreErrors.length
                } error(s): ${entityStoreErrors.join('; ')}`
              );
            }
          }
        }
      } while (afterKey !== undefined);
    }

    logger.info(`Risk score maintainer run completed for namespace "${namespace}"`);
    return status.state;
  },
});

export type RegisterRiskScoreMaintainerDeps = RiskScoreMaintainerDeps;
