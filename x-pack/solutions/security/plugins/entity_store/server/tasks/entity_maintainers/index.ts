/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { TaskManagerSetupContract } from '@kbn/task-manager-plugin/server';
import type { Logger } from '@kbn/logging';
import type { TaskManagerStartContract } from '@kbn/task-manager-plugin/server';
import type { CoreStart, ElasticsearchClient, KibanaRequest } from '@kbn/core/server';
import type { LicenseCheckState, LicenseType } from '@kbn/licensing-types';
import type { LicensingPluginStart } from '@kbn/licensing-plugin/server';
import {
  EntityMaintainerTaskStatus,
  EntityMaintainerTelemetryEventType,
  type EntityMaintainerState,
  type EntityMaintainerStatus,
  type EntityMaintainerTaskMethod,
  type RegisterEntityMaintainerConfig,
} from './types';
import { TasksConfig } from '../config';
import { EntityStoreTaskType } from '../constants';
import type {
  EntityStoreCoreSetup,
  EntityStoreStartContract,
  EntityStoreStartPlugins,
} from '../../types';
import { entityMaintainersRegistry } from './entity_maintainers_registry';
import { CRUDClient, type EntityUpdateClient } from '../../domain/crud';
import type { TelemetryReporter } from '../../telemetry/events';
import { ENTITY_MAINTAINER_EVENT } from '../../telemetry/events';
import { wrapTaskRun } from '../../telemetry/traces';

/** Used when `RegisterEntityMaintainerConfig.minLicense` is omitted (minimum Kibana tier). */
export const DEFAULT_ENTITY_MAINTAINER_MIN_LICENSE: LicenseType = 'basic';

const ENTITY_MAINTAINER_LICENSE_CHECK_VALID = 'valid' as const satisfies LicenseCheckState;

export function getTaskType(id: string): string {
  return `${TasksConfig[EntityStoreTaskType.enum.entityMaintainer].type}:${id}`;
}

export interface ExecuteMaintainerRunParams {
  currentStatus: Partial<EntityMaintainerStatus>;
  request: KibanaRequest;
  taskIdStr: string;
  taskAbortController?: AbortController;
  namespace?: string;
  id: string;
  run: EntityMaintainerTaskMethod;
  setup?: EntityMaintainerTaskMethod;
  initialState: EntityMaintainerState;
  effectiveMinLicense: LicenseType;
  type: string;
  coreStart: CoreStart;
  licensing: LicensingPluginStart;
  analytics: TelemetryReporter;
  logger: Logger;
}

export async function executeMaintainerRun({
  currentStatus,
  request,
  taskIdStr,
  taskAbortController,
  namespace,
  id,
  run,
  setup,
  initialState,
  effectiveMinLicense,
  type,
  coreStart,
  licensing,
  analytics,
  logger,
}: ExecuteMaintainerRunParams): Promise<{ state: EntityMaintainerStatus } | null> {
  if (currentStatus.taskStatus === EntityMaintainerTaskStatus.STOPPED) {
    logger.debug(`Entity maintainer task is stopped, skipping run`);
    return null;
  }

  const license = await licensing.getLicense();
  const checkResult = license.check('entityStore', effectiveMinLicense);
  if (checkResult.state !== ENTITY_MAINTAINER_LICENSE_CHECK_VALID) {
    logger.debug(`Entity maintainer "${id}" skipped: insufficient or inactive license`);
    return null;
  }

  const currentStatusNamespace =
    typeof currentStatus?.namespace === 'string' ? currentStatus.namespace : undefined;

  const maintainerStatus: EntityMaintainerStatus = {
    metadata: {
      runs: currentStatus?.metadata?.runs || 0,
      lastSuccessTimestamp: currentStatus?.metadata?.lastSuccessTimestamp || null,
      lastErrorTimestamp: currentStatus?.metadata?.lastErrorTimestamp || null,
      namespace: namespace ?? currentStatusNamespace ?? currentStatus?.metadata?.namespace ?? '',
    },
    state: currentStatus?.metadata?.runs ? currentStatus.state ?? initialState : initialState,
    taskStatus: currentStatus?.taskStatus ?? EntityMaintainerTaskStatus.STARTED,
  };

  const esClient = coreStart.elasticsearch.client.asScoped(request).asCurrentUser;
  const crudClient = new CRUDClient({
    logger,
    esClient,
    namespace: maintainerStatus.metadata.namespace,
  });
  const taskLogger = logger.get(taskIdStr);
  const abortController = taskAbortController ?? new AbortController();

  return await wrapTaskRun({
    spanName: 'entityStore.task.entity_maintainer.run',
    namespace: maintainerStatus.metadata.namespace,
    attributes: {
      'entity_store.task.id': taskIdStr,
      'entity_store.task.type': type,
      'entity_store.entity_maintainer.id': id,
    },
    run: () =>
      runEntityMaintainerTask({
        currentStatus: maintainerStatus,
        fakeRequest: request,
        logger: taskLogger,
        setup,
        run,
        abortController,
        esClient,
        crudClient,
        id,
        analytics,
      }),
  });
}

export function getTaskId(id: string, namespace: string): string {
  return `${id}:${namespace}`;
}

export async function scheduleEntityMaintainerTask({
  logger,
  taskManager,
  id,
  interval,
  namespace,
  request,
  enabled,
}: {
  logger: Logger;
  taskManager: TaskManagerStartContract;
  id: string;
  interval: string;
  namespace: string;
  request: KibanaRequest;
  enabled?: boolean;
}): Promise<void> {
  logger.debug(`Scheduling entity maintainer task: ${id}`);
  await taskManager.ensureScheduled(
    {
      id: getTaskId(id, namespace),
      taskType: getTaskType(id),
      schedule: { interval },
      state: { namespace, taskStatus: EntityMaintainerTaskStatus.STARTED },
      params: {},
      enabled: enabled ?? true,
    },
    { request }
  );
}

export function registerEntityMaintainerTask({
  taskManager,
  logger,
  config,
  core,
  analytics,
}: {
  taskManager: TaskManagerSetupContract;
  logger: Logger;
  config: RegisterEntityMaintainerConfig;
  core: EntityStoreCoreSetup;
  analytics: TelemetryReporter;
}): void {
  logger.debug(`Registering entity maintainer task: ${config.id}`);
  const { title } = TasksConfig[EntityStoreTaskType.enum.entityMaintainer];
  const { run, interval, initialState, description, id, setup, minLicense } = config;
  const effectiveMinLicense = minLicense ?? DEFAULT_ENTITY_MAINTAINER_MIN_LICENSE;
  const type = getTaskType(id);

  void core
    .getStartServices()
    .then(
      ([coreStart, plugins]: [CoreStart, EntityStoreStartPlugins, EntityStoreStartContract]) => {
        entityMaintainersRegistry.register({
          id,
          interval,
          description,
          minLicense: effectiveMinLicense,
          run,
          setup,
          initialState,
        });

        taskManager.registerTaskDefinitions({
          [type]: {
            title,
            description,
            createTaskRunner: ({ taskInstance, abortController, fakeRequest }) => ({
              run: async () => {
                const currentStatus = taskInstance.state;

                if (!fakeRequest) {
                  logger.error(`No fake request found, skipping run`);
                  return { state: currentStatus };
                }

                const result = await executeMaintainerRun({
                  currentStatus,
                  request: fakeRequest,
                  taskIdStr: taskInstance.id,
                  taskAbortController: abortController,
                  id,
                  run,
                  setup,
                  initialState,
                  effectiveMinLicense,
                  type,
                  coreStart,
                  licensing: plugins.licensing,
                  analytics,
                  logger,
                });

                return result ?? { state: currentStatus };
              },
            }),
          },
        });
      }
    )
    .catch((err) => {
      logger.error(`Failed to register entity maintainer task: ${err?.message}`);
    });
  analytics.reportEvent(ENTITY_MAINTAINER_EVENT, {
    id,
    type: EntityMaintainerTelemetryEventType.REGISTER,
  });
}

export async function runEntityMaintainerTask({
  currentStatus,
  fakeRequest,
  logger,
  setup,
  run,
  abortController,
  esClient,
  crudClient,
  id,
  analytics,
}: {
  currentStatus: EntityMaintainerStatus;
  fakeRequest: KibanaRequest;
  logger: Logger;
  setup?: EntityMaintainerTaskMethod;
  run: EntityMaintainerTaskMethod;
  abortController: AbortController;
  esClient: ElasticsearchClient;
  crudClient: EntityUpdateClient;
  id: string;
  analytics: TelemetryReporter;
}): Promise<{ state: EntityMaintainerStatus }> {
  const namespace = currentStatus.metadata.namespace;
  const onAbort = () => {
    logger.debug(`Abort signal received, stopping Entity Maintainer`);
    analytics.reportEvent(ENTITY_MAINTAINER_EVENT, {
      id,
      namespace,
      type: EntityMaintainerTelemetryEventType.ABORT,
    });
  };
  try {
    abortController.signal.addEventListener('abort', onAbort);
    const isFirstRun = currentStatus.metadata.runs === 0;
    if (isFirstRun && setup) {
      logger.debug(`First run, executing setup`);
      currentStatus.state = await setup({
        status: { ...currentStatus },
        abortController,
        logger,
        fakeRequest,
        esClient,
        crudClient,
      });
      analytics.reportEvent(ENTITY_MAINTAINER_EVENT, {
        id,
        namespace,
        type: EntityMaintainerTelemetryEventType.SETUP,
      });
    }
    logger.debug(`Executing run`);
    currentStatus.state = await run({
      status: { ...currentStatus },
      abortController,
      logger,
      fakeRequest,
      esClient,
      crudClient,
    });
    analytics.reportEvent(ENTITY_MAINTAINER_EVENT, {
      id,
      namespace,
      type: EntityMaintainerTelemetryEventType.RUN,
    });
    currentStatus.metadata.lastSuccessTimestamp = new Date().toISOString();
  } catch (err) {
    currentStatus.metadata.lastErrorTimestamp = new Date().toISOString();
    logger.debug(`Run failed - ${err?.message}`);
    analytics.reportEvent(ENTITY_MAINTAINER_EVENT, {
      id,
      namespace,
      type: EntityMaintainerTelemetryEventType.ERROR,
      errorMessage: err?.message?.substring(0, 500), // limit error message length to prevent excessively long strings in telemetry
    });
  } finally {
    currentStatus.metadata.runs++;
    abortController.signal.removeEventListener('abort', onAbort);
  }

  return {
    state: currentStatus,
  };
}

async function updateTaskStatus({
  taskManager,
  taskId,
  taskStatus,
  request,
}: {
  taskManager: TaskManagerStartContract;
  taskId: string;
  taskStatus: EntityMaintainerTaskStatus;
  request: KibanaRequest;
}): Promise<void> {
  await taskManager.bulkUpdateState([taskId], (state) => ({ ...state, taskStatus }), { request });
}

export async function stopEntityMaintainer({
  taskManager,
  id,
  namespace,
  logger,
  request,
  analytics,
}: {
  taskManager: TaskManagerStartContract;
  id: string;
  namespace: string;
  logger: Logger;
  request: KibanaRequest;
  analytics: TelemetryReporter;
}): Promise<void> {
  const taskId = getTaskId(id, namespace);
  await updateTaskStatus({
    taskManager,
    taskId,
    taskStatus: EntityMaintainerTaskStatus.STOPPED,
    request,
  });
  analytics.reportEvent(ENTITY_MAINTAINER_EVENT, {
    id,
    namespace,
    type: EntityMaintainerTelemetryEventType.STOP,
  });
  logger.debug(`Stopped entity maintainer task: ${taskId}`);
}

export async function startEntityMaintainer({
  taskManager,
  id,
  namespace,
  logger,
  request,
  analytics,
}: {
  taskManager: TaskManagerStartContract;
  id: string;
  namespace: string;
  logger: Logger;
  request: KibanaRequest;
  analytics: TelemetryReporter;
}): Promise<void> {
  const taskId = getTaskId(id, namespace);
  await updateTaskStatus({
    taskManager,
    taskId,
    taskStatus: EntityMaintainerTaskStatus.STARTED,
    request,
  });
  await taskManager.bulkEnable([taskId], false, { request });
  analytics.reportEvent(ENTITY_MAINTAINER_EVENT, {
    id,
    namespace,
    type: EntityMaintainerTelemetryEventType.START,
  });
  logger.debug(`Start entity maintainer task: ${taskId}`);
}

export async function removeEntityMaintainer({
  taskManager,
  id,
  namespace,
  logger,
  analytics,
}: {
  taskManager: TaskManagerStartContract;
  id: string;
  namespace: string;
  logger: Logger;
  analytics: TelemetryReporter;
}): Promise<void> {
  const taskId = getTaskId(id, namespace);
  await taskManager.removeIfExists(taskId);
  analytics.reportEvent(ENTITY_MAINTAINER_EVENT, {
    id,
    namespace,
    type: EntityMaintainerTelemetryEventType.DELETE,
  });
  logger.debug(`Removed entity maintainer task: ${taskId}`);
}
