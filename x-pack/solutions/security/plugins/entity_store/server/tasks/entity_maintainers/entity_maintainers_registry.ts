/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type {
  EntityMaintainerRegistryData,
  EntityMaintainerState,
  EntityMaintainerTaskEntry,
  EntityMaintainerTaskMethod,
} from './types';

export interface EntityMaintainerRunners {
  run: EntityMaintainerTaskMethod;
  setup?: EntityMaintainerTaskMethod;
  initialState: EntityMaintainerState;
}

export class EntityMaintainersRegistry {
  private readonly tasks = new Map<string, EntityMaintainerRegistryData>();
  private readonly runners = new Map<string, EntityMaintainerRunners>();

  hasId(id: string): boolean {
    return this.tasks.has(id);
  }

  get(id: string): EntityMaintainerTaskEntry | undefined {
    const config = this.tasks.get(id);
    if (!config) {
      return undefined;
    }
    return { id, ...config };
  }

  register({
    id,
    interval,
    description,
    minLicense,
    run,
    setup,
    initialState,
  }: EntityMaintainerTaskEntry & EntityMaintainerRunners): void {
    this.tasks.set(id, { interval, description, minLicense });
    this.runners.set(id, { run, setup, initialState });
  }

  getRunners(id: string): EntityMaintainerRunners | undefined {
    return this.runners.get(id);
  }

  getAll(): EntityMaintainerTaskEntry[] {
    return Array.from(this.tasks.entries()).map(([id, entry]) => ({
      id,
      ...entry,
    }));
  }
}

export const entityMaintainersRegistry = new EntityMaintainersRegistry();
