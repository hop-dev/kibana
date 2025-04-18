/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { MockedLogger } from '@kbn/logging-mocks';
import { loggerMock } from '@kbn/logging-mocks';
import { TaskRunnerFactory } from '../task_runner';
import type { ConstructorOptions } from '../rule_type_registry';
import { RuleTypeRegistry } from '../rule_type_registry';
import { taskManagerMock } from '@kbn/task-manager-plugin/server/mocks';
import type { ILicenseState } from '../lib/license_state';
import { licenseStateMock } from '../lib/license_state.mock';
import { licensingMock } from '@kbn/licensing-plugin/server/mocks';
import { isRuleExportable } from './is_rule_exportable';
import { inMemoryMetricsMock } from '../monitoring/in_memory_metrics.mock';
import { loggingSystemMock } from '@kbn/core/server/mocks';
import type { AlertingConfig } from '../config';
import { RULE_SAVED_OBJECT_TYPE } from '.';

let ruleTypeRegistryParams: ConstructorOptions;
let logger: MockedLogger;
let mockedLicenseState: jest.Mocked<ILicenseState>;
const taskManager = taskManagerMock.createSetup();
const inMemoryMetrics = inMemoryMetricsMock.create();

beforeEach(() => {
  jest.resetAllMocks();
  mockedLicenseState = licenseStateMock.create();
  logger = loggerMock.create();
  ruleTypeRegistryParams = {
    config: {} as AlertingConfig,
    logger: loggingSystemMock.create().get(),
    taskManager,
    alertsService: null,
    taskRunnerFactory: new TaskRunnerFactory(),
    licenseState: mockedLicenseState,
    licensing: licensingMock.createSetup(),
    minimumScheduleInterval: { value: '1m', enforce: false },
    inMemoryMetrics,
  };
});

describe('isRuleExportable', () => {
  it('should return true if rule type isExportable is true', () => {
    const registry = new RuleTypeRegistry(ruleTypeRegistryParams);
    registry.register({
      id: 'foo',
      name: 'Foo',
      actionGroups: [
        {
          id: 'default',
          name: 'Default',
        },
      ],
      defaultActionGroupId: 'default',
      minimumLicenseRequired: 'basic',
      isExportable: true,
      executor: jest.fn(),
      category: 'test',
      producer: 'alerts',
      validate: {
        params: { validate: (params) => params },
      },
    });
    expect(
      isRuleExportable(
        {
          id: '1',
          type: RULE_SAVED_OBJECT_TYPE,
          attributes: {
            enabled: true,
            name: 'rule-name',
            tags: ['tag-1', 'tag-2'],
            alertTypeId: 'foo',
            consumer: 'alert-consumer',
            schedule: { interval: '1m' },
            actions: [],
            params: {},
            createdBy: 'me',
            updatedBy: 'me',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            apiKey: '4tndskbuhewotw4klrhgjewrt9u',
            apiKeyOwner: 'me',
            throttle: null,
            notifyWhen: 'onActionGroupChange',
            muteAll: false,
            mutedInstanceIds: [],
            executionStatus: {
              status: 'active',
              lastExecutionDate: '2020-08-20T19:23:38Z',
              error: null,
            },
            scheduledTaskId: '2q5tjbf3q45twer',
          },
          references: [],
        },
        registry,
        logger
      )
    ).toEqual(true);
  });

  it('should return false and log warning if rule type isExportable is false', () => {
    const registry = new RuleTypeRegistry(ruleTypeRegistryParams);
    registry.register({
      id: 'foo',
      name: 'Foo',
      actionGroups: [
        {
          id: 'default',
          name: 'Default',
        },
      ],
      defaultActionGroupId: 'default',
      minimumLicenseRequired: 'basic',
      isExportable: false,
      executor: jest.fn(),
      category: 'test',
      producer: 'alerts',
      validate: {
        params: { validate: (params) => params },
      },
    });
    expect(
      isRuleExportable(
        {
          id: '1',
          type: RULE_SAVED_OBJECT_TYPE,
          attributes: {
            enabled: true,
            name: 'rule-name',
            tags: ['tag-1', 'tag-2'],
            alertTypeId: 'foo',
            consumer: 'alert-consumer',
            schedule: { interval: '1m' },
            actions: [],
            params: {},
            createdBy: 'me',
            updatedBy: 'me',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            apiKey: '4tndskbuhewotw4klrhgjewrt9u',
            apiKeyOwner: 'me',
            throttle: null,
            notifyWhen: 'onActionGroupChange',
            muteAll: false,
            mutedInstanceIds: [],
            executionStatus: {
              status: 'active',
              lastExecutionDate: '2020-08-20T19:23:38Z',
              error: null,
            },
            scheduledTaskId: '2q5tjbf3q45twer',
          },
          references: [],
        },
        registry,
        logger
      )
    ).toEqual(false);
    expect(logger.warn).toHaveBeenCalledWith(
      `Skipping export of rule \"1\" because rule type \"foo\" is not exportable through this interface.`
    );
  });

  it('should return false and log warning if rule type is not registered', () => {
    const registry = new RuleTypeRegistry(ruleTypeRegistryParams);
    registry.register({
      id: 'foo',
      name: 'Foo',
      actionGroups: [
        {
          id: 'default',
          name: 'Default',
        },
      ],
      defaultActionGroupId: 'default',
      minimumLicenseRequired: 'basic',
      isExportable: false,
      executor: jest.fn(),
      category: 'test',
      producer: 'alerts',
      validate: {
        params: { validate: (params) => params },
      },
    });
    expect(
      isRuleExportable(
        {
          id: '1',
          type: RULE_SAVED_OBJECT_TYPE,
          attributes: {
            enabled: true,
            name: 'rule-name',
            tags: ['tag-1', 'tag-2'],
            alertTypeId: 'bar',
            consumer: 'alert-consumer',
            schedule: { interval: '1m' },
            actions: [],
            params: {},
            createdBy: 'me',
            updatedBy: 'me',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            apiKey: '4tndskbuhewotw4klrhgjewrt9u',
            apiKeyOwner: 'me',
            throttle: null,
            notifyWhen: 'onActionGroupChange',
            muteAll: false,
            mutedInstanceIds: [],
            executionStatus: {
              status: 'active',
              lastExecutionDate: '2020-08-20T19:23:38Z',
              error: null,
            },
            scheduledTaskId: '2q5tjbf3q45twer',
          },
          references: [],
        },
        registry,
        logger
      )
    ).toEqual(false);
    expect(logger.warn).toHaveBeenCalledWith(
      `Skipping export of rule \"1\" because rule type \"bar\" is not recognized.`
    );
  });
});
