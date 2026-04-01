/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types';
import { isEmpty } from 'lodash';
import { fromKueryExpression, toElasticsearchQuery } from '@kbn/es-query';
import type { RiskEngineConfiguration } from '../../../types';
import type { EntityType } from '../../../../../../common/search_strategy';
import { filterFromRange } from '../../helpers';
import { convertRangeToISO } from '../../tasks/helpers';
import type { ScopedLogger } from '../utils/with_log_context';

export const buildAlertFilters = (
  configuration: RiskEngineConfiguration,
  entityType: EntityType,
  logger?: ScopedLogger
): QueryDslQueryContainer[] => {
  const range = convertRangeToISO(configuration.range);
  const filters: QueryDslQueryContainer[] = [
    filterFromRange(range),
    { exists: { field: 'kibana.alert.risk_score' } },
  ];

  if (!isEmpty(configuration.filter)) {
    filters.push(configuration.filter as QueryDslQueryContainer);
  }

  if (configuration.excludeAlertStatuses && configuration.excludeAlertStatuses.length > 0) {
    filters.push({
      bool: {
        must_not: {
          terms: { 'kibana.alert.workflow_status': configuration.excludeAlertStatuses },
        },
      },
    });
  }

  if (configuration.excludeAlertTags && configuration.excludeAlertTags.length > 0) {
    filters.push({
      bool: {
        must_not: { terms: { 'kibana.alert.workflow_tags': configuration.excludeAlertTags } },
      },
    });
  }

  // Apply entity-specific custom filters from saved object configuration.
  if (configuration.filters && configuration.filters.length > 0) {
    configuration.filters
      .filter((customFilter) => customFilter.entity_types.includes(entityType))
      .forEach((customFilter) => {
        try {
          const kqlQuery = fromKueryExpression(customFilter.filter);
          const esQuery = toElasticsearchQuery(kqlQuery);
          if (esQuery) {
            filters.push({
              bool: { must: esQuery },
            });
          }
        } catch (error) {
          // Ignore invalid KQL to avoid failing scoring runs due to bad user input.
          // Emit a warning so misconfigurations are observable.
          logger?.warn(
            `Skipping invalid KQL custom filter for ${entityType}: "${customFilter.filter}" — ${error}`
          );
        }
      });
  }

  return filters;
};
