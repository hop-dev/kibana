/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { PathsOf } from '@kbn/typed-react-router-config';
import { useRoutePath } from '@kbn/typed-react-router-config';
import type { ProfilingRoutes } from '../routing';

export function useProfilingRoutePath(): PathsOf<ProfilingRoutes> {
  return useRoutePath() as PathsOf<ProfilingRoutes>;
}
