/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { createAlertEventLogRecordObject } from './create_alert_event_log_record_object';
import type { UntypedNormalizedRuleType } from '../rule_type_registry';
import { RecoveredActionGroup } from '../types';
import { schema } from '@kbn/config-schema';

const MAINTENANCE_WINDOW_IDS = ['test-1', 'test-2'];

describe('createAlertEventLogRecordObject', () => {
  const ruleType: jest.Mocked<UntypedNormalizedRuleType> = {
    id: 'test',
    name: 'My test alert',
    actionGroups: [{ id: 'default', name: 'Default' }, RecoveredActionGroup],
    defaultActionGroupId: 'default',
    minimumLicenseRequired: 'basic',
    isExportable: true,
    recoveryActionGroup: RecoveredActionGroup,
    executor: jest.fn(),
    category: 'test',
    producer: 'alerts',
    validate: {
      params: schema.any(),
    },
    validLegacyConsumers: [],
  };

  test('created alert event "execute-start"', async () => {
    expect(
      createAlertEventLogRecordObject({
        executionId: '7a7065d7-6e8b-4aae-8d20-c93613dec9fb',
        ruleId: '1',
        ruleType,
        consumer: 'rule-consumer',
        action: 'execute-start',
        ruleRevision: 0,
        timestamp: '1970-01-01T00:00:00.000Z',
        task: {
          scheduled: '1970-01-01T00:00:00.000Z',
          scheduleDelay: 0,
        },
        savedObjects: [
          {
            id: '1',
            type: 'alert',
            typeId: ruleType.id,
            relation: 'primary',
          },
        ],
        spaceId: 'default',
        maintenanceWindowIds: MAINTENANCE_WINDOW_IDS,
      })
    ).toStrictEqual({
      '@timestamp': '1970-01-01T00:00:00.000Z',
      event: {
        action: 'execute-start',
        category: ['alerts'],
        kind: 'alert',
      },
      kibana: {
        alert: {
          rule: {
            consumer: 'rule-consumer',
            execution: {
              uuid: '7a7065d7-6e8b-4aae-8d20-c93613dec9fb',
            },
            revision: 0,
            rule_type_id: 'test',
          },
          maintenance_window_ids: MAINTENANCE_WINDOW_IDS,
        },
        saved_objects: [
          {
            id: '1',
            namespace: undefined,
            rel: 'primary',
            type: 'alert',
            type_id: 'test',
          },
        ],
        space_ids: ['default'],
        task: {
          schedule_delay: 0,
          scheduled: '1970-01-01T00:00:00.000Z',
        },
      },
      rule: {
        category: 'test',
        id: '1',
        license: 'basic',
        ruleset: 'alerts',
      },
    });
  });

  test('created alert event "recovered-instance"', async () => {
    expect(
      createAlertEventLogRecordObject({
        executionId: '7a7065d7-6e8b-4aae-8d20-c93613dec9fb',
        ruleId: '1',
        ruleName: 'test name',
        ruleType,
        consumer: 'rule-consumer',
        action: 'recovered-instance',
        instanceId: 'test1',
        group: 'group 1',
        message: 'message text here',
        namespace: 'default',
        ruleRevision: 0,
        state: {
          start: '1970-01-01T00:00:00.000Z',
          end: '1970-01-01T00:05:00.000Z',
          duration: 5,
        },
        savedObjects: [
          {
            id: '1',
            type: 'alert',
            typeId: ruleType.id,
            relation: 'primary',
          },
        ],
        spaceId: 'default',
        maintenanceWindowIds: MAINTENANCE_WINDOW_IDS,
      })
    ).toStrictEqual({
      event: {
        action: 'recovered-instance',
        category: ['alerts'],
        duration: 5,
        end: '1970-01-01T00:05:00.000Z',
        kind: 'alert',
        start: '1970-01-01T00:00:00.000Z',
      },
      kibana: {
        alert: {
          rule: {
            consumer: 'rule-consumer',
            execution: {
              uuid: '7a7065d7-6e8b-4aae-8d20-c93613dec9fb',
            },
            revision: 0,
            rule_type_id: 'test',
          },
          maintenance_window_ids: MAINTENANCE_WINDOW_IDS,
        },
        alerting: {
          action_group_id: 'group 1',
          instance_id: 'test1',
        },
        saved_objects: [
          {
            id: '1',
            namespace: 'default',
            rel: 'primary',
            type: 'alert',
            type_id: 'test',
          },
        ],
        space_ids: ['default'],
      },
      message: 'message text here',
      rule: {
        category: 'test',
        id: '1',
        license: 'basic',
        ruleset: 'alerts',
        name: 'test name',
      },
    });
  });

  test('created alert event "execute-action"', async () => {
    expect(
      createAlertEventLogRecordObject({
        executionId: '7a7065d7-6e8b-4aae-8d20-c93613dec9fb',
        ruleId: '1',
        ruleName: 'test name',
        ruleType,
        consumer: 'rule-consumer',
        action: 'execute-action',
        instanceId: 'test1',
        group: 'group 1',
        message: 'action execution start',
        namespace: 'default',
        ruleRevision: 0,
        state: {
          start: '1970-01-01T00:00:00.000Z',
          end: '1970-01-01T00:05:00.000Z',
          duration: 5,
        },
        savedObjects: [
          {
            id: '1',
            type: 'alert',
            typeId: ruleType.id,
            relation: 'primary',
          },
          {
            id: '2',
            type: 'action',
            typeId: '.email',
          },
        ],
        spaceId: 'default',
        alertSummary: {
          new: 2,
          ongoing: 3,
          recovered: 1,
        },
        maintenanceWindowIds: MAINTENANCE_WINDOW_IDS,
      })
    ).toStrictEqual({
      event: {
        action: 'execute-action',
        category: ['alerts'],
        duration: 5,
        end: '1970-01-01T00:05:00.000Z',
        kind: 'alert',
        start: '1970-01-01T00:00:00.000Z',
      },
      kibana: {
        alert: {
          rule: {
            consumer: 'rule-consumer',
            execution: {
              uuid: '7a7065d7-6e8b-4aae-8d20-c93613dec9fb',
            },
            revision: 0,
            rule_type_id: 'test',
          },
          maintenance_window_ids: MAINTENANCE_WINDOW_IDS,
        },
        alerting: {
          action_group_id: 'group 1',
          instance_id: 'test1',
          summary: {
            new: {
              count: 2,
            },
            ongoing: {
              count: 3,
            },
            recovered: {
              count: 1,
            },
          },
        },
        saved_objects: [
          {
            id: '1',
            namespace: 'default',
            rel: 'primary',
            type: 'alert',
            type_id: 'test',
          },
          {
            id: '2',
            namespace: 'default',
            type: 'action',
            type_id: '.email',
          },
        ],
        space_ids: ['default'],
      },
      message: 'action execution start',
      rule: {
        category: 'test',
        id: '1',
        license: 'basic',
        ruleset: 'alerts',
        name: 'test name',
      },
    });
  });
});
