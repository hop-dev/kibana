/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { QueryDslQueryContainer } from '@elastic/elasticsearch/lib/api/types';
import type { RiskEngineConfiguration } from '../../types';
import { filterFromRange } from '../helpers';
import { convertRangeToISO } from '../tasks/helpers';

export const buildAlertFilters = (
  configuration: RiskEngineConfiguration
): QueryDslQueryContainer[] => {
  const range = convertRangeToISO(configuration.range);
  const filters: QueryDslQueryContainer[] = [filterFromRange(range)];

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

  return filters;
};
