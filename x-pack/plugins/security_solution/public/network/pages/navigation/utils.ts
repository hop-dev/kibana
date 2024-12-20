/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { NETWORK_PATH } from '../../../../common/constants';
import type { GetNetworkRoutePath } from './types';
import { NetworkRouteType } from './types';

export const getNetworkRoutePath: GetNetworkRoutePath = (
  capabilitiesFetched,
  hasMlUserPermission
) => {
  if (capabilitiesFetched && !hasMlUserPermission) {
    return `${NETWORK_PATH}/:tabName(${NetworkRouteType.flows}|${NetworkRouteType.dns}|${NetworkRouteType.http}|${NetworkRouteType.tls}|${NetworkRouteType.alerts})`;
  }

  return (
    `${NETWORK_PATH}/:tabName(` +
    `${NetworkRouteType.flows}|` +
    `${NetworkRouteType.dns}|` +
    `${NetworkRouteType.anomalies}|` +
    `${NetworkRouteType.http}|` +
    `${NetworkRouteType.tls}|` +
    `${NetworkRouteType.alerts})`
  );
};
