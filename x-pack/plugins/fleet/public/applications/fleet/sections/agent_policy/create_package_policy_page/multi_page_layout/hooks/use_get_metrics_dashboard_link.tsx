/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { useEffect, useState } from 'react';
import type { ResolvedSimpleSavedObject } from '@kbn/core/public';

import type { AssetSavedObject } from '../../../../../../integrations/sections/epm/screens/detail/assets/types';

import { KibanaAssetType } from '../../../../../../../../common/types';
import type { PackageInfo } from '../../../../../../../../common/types';
import { getHrefToObjectInKibanaApp, useStartServices } from '../../../../../../../hooks';

export const useGetFirstMetricsDashboardLink = (packageInfo: PackageInfo) => {
  const {
    savedObjects: { client: savedObjectsClient },
    http,
  } = useStartServices();

  const [result, setResult] = useState<{ isLoading: boolean; link?: string }>({ isLoading: true });
  useEffect(() => {
    const getFirstDashboard = async () => {
      setResult({ isLoading: true });
      if (!('savedObject' in packageInfo)) return;

      const dashboards = packageInfo.savedObject?.attributes?.installed_kibana.filter(
        (asset) => asset.type === 'dashboard'
      );

      const dashboardSavedObjects = await savedObjectsClient
        .bulkResolve(dashboards)
        // Ignore privilege errors
        .catch((e: any) => {
          if (e?.body?.statusCode === 403) {
            return { resolved_objects: [] };
          } else {
            throw e;
          }
        })
        .then((res: { resolved_objects: ResolvedSimpleSavedObject[] }) => {
          const { resolved_objects: resolvedObjects } = res;
          return resolvedObjects
            .map(({ saved_object: savedObject }) => savedObject)
            .filter((savedObject) => savedObject?.error?.statusCode !== 404) as AssetSavedObject[];
        });
      const metricsDashboards = dashboardSavedObjects.filter((so) =>
        so.attributes.title.toLowerCase().includes('metrics')
      );

      const firstMetricsDashboard = metricsDashboards?.[0];

      if (firstMetricsDashboard) {
        const link = getHrefToObjectInKibanaApp({
          http,
          id: firstMetricsDashboard.id,
          type: KibanaAssetType.dashboard,
        });

        setResult({ isLoading: false, link });
      } else {
        setResult({ isLoading: false });
      }
    };

    getFirstDashboard();
  }, [http, packageInfo, savedObjectsClient]);

  return result;
};
