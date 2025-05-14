/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { useQuery } from '@tanstack/react-query';
import dateMath from '@kbn/datemath';
import type { MatchedEntitiesPreviewRiskScoreRequestBody } from '../../../../common/api/entity_analytics/risk_engine/preview_matched_entities_route.gen';
import { useEntityAnalyticsRoutes } from '../api';

export type UseRiskScorePreviewParams = Omit<
  MatchedEntitiesPreviewRiskScoreRequestBody,
  'data_view_id'
> & {
  data_view_id?: string;
};

export const useRiskScorePreviewMatchedUsers = ({
  data_view_id: dataViewId,
  range,
  filter,
  exclude_alert_statuses: excludeAlertStatuses,
  matched_entities: matchedUsers,
  skip = false,
}: UseRiskScorePreviewParams & {
  matched_entities: string[];
  skip?: boolean;
}) => {
  const { fetchRiskScorePreviewMatchedUsers } = useEntityAnalyticsRoutes();

  return useQuery(
    [
      'POST',
      'FETCH_PREVIEW_RISK_SCORE_MATCHED_ENTITIES',
      range,
      filter,
      excludeAlertStatuses,
      matchedUsers,
    ],
    async ({ signal }) => {
      if (!dataViewId) {
        return;
      }

      const params: MatchedEntitiesPreviewRiskScoreRequestBody = {
        data_view_id: dataViewId,
        matched_entities: matchedUsers,
      };
      if (range) {
        const startTime = dateMath.parse(range.start)?.utc().toISOString();
        const endTime = dateMath
          .parse(range.end, {
            roundUp: true,
          })
          ?.utc()
          .toISOString();

        if (startTime && endTime) {
          params.range = {
            start: startTime,
            end: endTime,
          };
        }
      }

      if (filter) {
        params.filter = filter;
      }

      if (excludeAlertStatuses) {
        params.exclude_alert_statuses = excludeAlertStatuses;
      }

      const response = await fetchRiskScorePreviewMatchedUsers({ signal, params });

      return response;
    },
    { enabled: !skip, refetchOnWindowFocus: false }
  );
};
