/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { maintainerIdParamsSchema, maintainerIdsQuerySchema } from './validator';

jest.mock('../../../../tasks/entity_maintainers/entity_maintainers_registry', () => ({
  entityMaintainersRegistry: {
    hasId: jest.fn(),
  },
}));

const { entityMaintainersRegistry } = jest.requireMock(
  '../../../../tasks/entity_maintainers/entity_maintainers_registry'
) as {
  entityMaintainersRegistry: {
    hasId: jest.MockedFunction<(id: string) => boolean>;
  };
};

describe('entity maintainer validators', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('maintainerIdParamsSchema', () => {
    it('accepts known maintainer id', () => {
      entityMaintainersRegistry.hasId.mockReturnValue(true);

      expect(maintainerIdParamsSchema.parse({ id: 'risk-score' })).toEqual({ id: 'risk-score' });
    });

    it('rejects unknown maintainer id', () => {
      entityMaintainersRegistry.hasId.mockReturnValue(false);

      expect(() => maintainerIdParamsSchema.parse({ id: 'unknown-id' })).toThrow(
        'Entity maintainer not found'
      );
    });
  });

  describe('maintainerIdsQuerySchema', () => {
    it('accepts missing ids', () => {
      expect(maintainerIdsQuerySchema.parse({})).toEqual({});
    });

    it('accepts ids as a string', () => {
      expect(maintainerIdsQuerySchema.parse({ ids: 'risk-score' })).toEqual({ ids: 'risk-score' });
    });

    it('accepts ids as a string array', () => {
      expect(maintainerIdsQuerySchema.parse({ ids: ['risk-score', 'asset-criticality'] })).toEqual(
        { ids: ['risk-score', 'asset-criticality'] }
      );
    });
  });
});
