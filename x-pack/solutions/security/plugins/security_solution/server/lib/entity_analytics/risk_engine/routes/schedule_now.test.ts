/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { taskManagerMock } from '@kbn/task-manager-plugin/server/mocks';
import { riskEngineScheduleNowRoute } from './schedule_now';
import { RISK_ENGINE_SCHEDULE_NOW_URL } from '../../../../../common/constants';
import {
  serverMock,
  requestContextMock,
  requestMock,
} from '../../../detection_engine/routes/__mocks__';
import { riskEngineDataClientMock } from '../risk_engine_data_client.mock';
import { riskEnginePrivilegesMock } from './risk_engine_privileges.mock';

describe('risk engine schedule now route', () => {
  let server: ReturnType<typeof serverMock.create>;
  let context: ReturnType<typeof requestContextMock.convertContext>;
  let mockTaskManagerStart: ReturnType<typeof taskManagerMock.createStart>;
  let mockRiskEngineDataClient: ReturnType<typeof riskEngineDataClientMock.create>;
  let getStartServicesMock: jest.Mock;

  beforeEach(() => {
    server = serverMock.create();
    const { clients } = requestContextMock.createTools();
    mockRiskEngineDataClient = riskEngineDataClientMock.create();
    context = requestContextMock.convertContext(
      requestContextMock.create({
        ...clients,
        riskEngineDataClient: mockRiskEngineDataClient,
      })
    );
    mockTaskManagerStart = taskManagerMock.createStart();
  });

  const buildRequest = () => {
    return requestMock.create({
      method: 'post',
      path: RISK_ENGINE_SCHEDULE_NOW_URL,
      body: {},
    });
  };

  describe('when task manager is available', () => {
    beforeEach(() => {
      getStartServicesMock = jest.fn().mockResolvedValue([
        {},
        {
          taskManager: mockTaskManagerStart,
          security: riskEnginePrivilegesMock.createMockSecurityStartWithFullRiskEngineAccess(),
        },
      ]);
      riskEngineScheduleNowRoute(server.router, getStartServicesMock, false);
    });

    it('invokes risk engine schedule now client', async () => {
      const request = buildRequest();
      await server.inject(request, context);

      expect(mockRiskEngineDataClient.scheduleNow).toHaveBeenCalled();
    });

    it('returns a 200 response when scheduling is successful', async () => {
      mockRiskEngineDataClient.scheduleNow.mockResolvedValue(undefined);
      const request = buildRequest();
      const response = await server.inject(request, context);

      expect(response.status).toEqual(200);
      expect(response.body).toEqual({ success: true });
    });
  });

  describe('when task manager is unavailable', () => {
    beforeEach(() => {
      getStartServicesMock = jest.fn().mockResolvedValue([
        {},
        {
          taskManager: undefined,
          security: riskEnginePrivilegesMock.createMockSecurityStartWithFullRiskEngineAccess(),
        },
      ]);
      riskEngineScheduleNowRoute(server.router, getStartServicesMock, false);
    });

    it('returns a 400 response', async () => {
      const request = buildRequest();
      const response = await server.inject(request, context);

      expect(response.status).toEqual(400);
      expect(response.body).toEqual({
        message:
          'Task Manager is unavailable, but is required by the risk engine. Please enable the taskManager plugin and try again.',
        status_code: 400,
      });
    });
  });

  describe('when Entity Store V2 is enabled', () => {
    beforeEach(() => {
      getStartServicesMock = jest.fn().mockResolvedValue([
        {},
        {
          taskManager: mockTaskManagerStart,
          security: riskEnginePrivilegesMock.createMockSecurityStartWithFullRiskEngineAccess(),
        },
      ]);
      riskEngineScheduleNowRoute(server.router, getStartServicesMock, true);
    });

    it('returns a 400 response', async () => {
      const request = buildRequest();
      const response = await server.inject(request, context);

      expect(response.status).toEqual(400);
      expect(response.body).toEqual({
        message:
          'This API is not available when Entity Store V2 is enabled. Use the Entity Store APIs instead.',
        status_code: 400,
      });
      expect(mockRiskEngineDataClient.scheduleNow).not.toHaveBeenCalled();
    });
  });
});
