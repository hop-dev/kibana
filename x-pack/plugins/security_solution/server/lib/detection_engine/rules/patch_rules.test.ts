/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { rulesClientMock } from '@kbn/alerting-plugin/server/rules_client.mock';

import { patchRules } from './patch_rules';
import { getRuleMock } from '../routes/__mocks__/request_responses';
import { getMlRuleParams, getQueryRuleParams } from '../schemas/rule_schemas.mock';
import {
  getCreateMachineLearningRulesSchemaMock,
  getCreateRulesSchemaMock,
} from '../../../../common/detection_engine/schemas/request/rule_schemas.mock';

describe('patchRules', () => {
  it('should call rulesClient.disable if the rule was enabled and enabled is false', async () => {
    const rulesClient = rulesClientMock.create();
    const params = {
      ...getCreateRulesSchemaMock(),
      enabled: false,
    };
    const rule = {
      ...getRuleMock(getQueryRuleParams()),
      enabled: true,
    };
    rulesClient.update.mockResolvedValue(getRuleMock(getQueryRuleParams()));
    await patchRules({ rulesClient, params, rule });
    expect(rulesClient.disable).toHaveBeenCalledWith(
      expect.objectContaining({
        id: rule.id,
      })
    );
  });

  it('should call rulesClient.enable if the rule was disabled and enabled is true', async () => {
    const rulesClient = rulesClientMock.create();
    const params = {
      ...getCreateRulesSchemaMock(),
      enabled: true,
    };
    const rule = {
      ...getRuleMock(getQueryRuleParams()),
      enabled: false,
    };
    rulesClient.update.mockResolvedValue(getRuleMock(getQueryRuleParams()));
    await patchRules({ rulesClient, params, rule });
    expect(rulesClient.enable).toHaveBeenCalledWith(
      expect.objectContaining({
        id: rule.id,
      })
    );
  });

  it('calls the rulesClient with legacy ML params', async () => {
    const rulesClient = rulesClientMock.create();
    const params = getCreateMachineLearningRulesSchemaMock();
    const rule = getRuleMock(getMlRuleParams());
    rulesClient.update.mockResolvedValue(getRuleMock(getMlRuleParams()));
    await patchRules({ rulesClient, params, rule });
    expect(rulesClient.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          params: expect.objectContaining({
            anomalyThreshold: 58,
            machineLearningJobId: ['typical-ml-job-id'],
          }),
        }),
      })
    );
  });

  it('calls the rulesClient with new ML params', async () => {
    const rulesClient = rulesClientMock.create();
    const params = {
      ...getCreateMachineLearningRulesSchemaMock(),
      machine_learning_job_id: ['new_job_1', 'new_job_2'],
    };
    const rule = getRuleMock(getMlRuleParams());
    rulesClient.update.mockResolvedValue(getRuleMock(getMlRuleParams()));
    await patchRules({ rulesClient, params, rule });
    expect(rulesClient.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          params: expect.objectContaining({
            anomalyThreshold: 58,
            machineLearningJobId: ['new_job_1', 'new_job_2'],
          }),
        }),
      })
    );
  });

  describe('regression tests', () => {
    it("updates the rule's actions if provided", async () => {
      const rulesClient = rulesClientMock.create();
      const params = {
        ...getCreateRulesSchemaMock(),
        actions: [
          {
            action_type_id: '.slack',
            id: '2933e581-d81c-4fe3-88fe-c57c6b8a5bfd',
            params: {
              message: 'Rule {{context.rule.name}} generated {{state.signals_count}} signals',
            },
            group: 'default',
          },
        ],
      };
      const rule = getRuleMock(getQueryRuleParams());
      rulesClient.update.mockResolvedValue(getRuleMock(getQueryRuleParams()));
      await patchRules({ rulesClient, params, rule });
      expect(rulesClient.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actions: [
              {
                actionTypeId: '.slack',
                id: '2933e581-d81c-4fe3-88fe-c57c6b8a5bfd',
                params: {
                  message: 'Rule {{context.rule.name}} generated {{state.signals_count}} signals',
                },
                group: 'default',
              },
            ],
          }),
        })
      );
    });

    it('does not update actions if none are specified', async () => {
      const rulesClient = rulesClientMock.create();
      const params = getCreateRulesSchemaMock();
      delete params.actions;
      const rule = getRuleMock(getQueryRuleParams());
      rule.actions = [
        {
          actionTypeId: '.slack',
          id: '2933e581-d81c-4fe3-88fe-c57c6b8a5bfd',
          params: {
            message: 'Rule {{context.rule.name}} generated {{state.signals_count}} signals',
          },
          group: 'default',
        },
      ];
      rulesClient.update.mockResolvedValue(getRuleMock(getQueryRuleParams()));
      await patchRules({ rulesClient, params, rule });
      expect(rulesClient.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            actions: [
              {
                actionTypeId: '.slack',
                id: '2933e581-d81c-4fe3-88fe-c57c6b8a5bfd',
                params: {
                  message: 'Rule {{context.rule.name}} generated {{state.signals_count}} signals',
                },
                group: 'default',
              },
            ],
          }),
        })
      );
    });
  });
});
