/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';

export type ScopedLogger = Pick<Logger, 'debug' | 'info' | 'warn' | 'error'>;

export const withLogContext = (logger: ScopedLogger, context: string): ScopedLogger => ({
  debug: (message) => logger.debug(`${context} ${message}`),
  info: (message) => logger.info(`${context} ${message}`),
  warn: (message) => logger.warn(`${context} ${message}`),
  error: (message) => logger.error(`${context} ${message}`),
});
