/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { verifyMonitoringAuth } from '../../../../lib/elasticsearch/verify_monitoring_auth';
import { handleError } from '../../../../lib/errors';
import { LegacyRequest, MonitoringCore } from '../../../../types';

/*
 * API for checking read privilege on Monitoring Data
 * Used for the "Access Denied" page as something to auto-retry with.
 */

// TODO: Replace this legacy route registration with the "new platform" core Kibana route method
export function checkAccessRoute(server: MonitoringCore) {
  server.route({
    method: 'get',
    path: '/api/monitoring/v1/check_access',
    validate: {},
    handler: async (req: LegacyRequest) => {
      const response: { has_access?: boolean } = {};
      try {
        await verifyMonitoringAuth(req);
        response.has_access = true; // response data is ignored
      } catch (err) {
        throw handleError(err, req);
      }
      return response;
    },
  });
}
