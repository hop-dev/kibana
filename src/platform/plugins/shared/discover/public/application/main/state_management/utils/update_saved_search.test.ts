/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the "Elastic License
 * 2.0", the "GNU Affero General Public License v3.0 only", and the "Server Side
 * Public License v 1"; you may not use this file except in compliance with, at
 * your election, the "Elastic License 2.0", the "GNU Affero General Public
 * License v3.0 only", or the "Server Side Public License, v 1".
 */

import { savedSearchMock } from '../../../../__mocks__/saved_search';
import { discoverServiceMock } from '../../../../__mocks__/services';
import type { Filter, Query } from '@kbn/es-query';
import { FilterStateStore } from '@kbn/es-query';
import { updateSavedSearch } from './update_saved_search';
import type { SavedSearch } from '@kbn/saved-search-plugin/public';

describe('updateSavedSearch', () => {
  const query: Query = {
    query: 'extension:jpg',
    language: 'kuery',
  };
  const appFilter: Filter = {
    meta: {},
    query: {
      match_phrase: {
        extension: {
          query: 'jpg',
          type: 'phrase',
        },
      },
    },
    $state: {
      store: FilterStateStore.APP_STATE,
    },
  };
  const globalFilter: Filter = {
    meta: {},
    query: {
      match_phrase: {
        extension: {
          query: 'png',
          type: 'phrase',
        },
      },
    },
    $state: {
      store: FilterStateStore.GLOBAL_STATE,
    },
  };
  const createGlobalStateContainer = () => ({
    get: jest.fn(() => ({ filters: [globalFilter] })),
    set: jest.fn(),
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should set query and filters from appState and globalState', async () => {
    const savedSearch = {
      ...savedSearchMock,
      searchSource: savedSearchMock.searchSource.createCopy(),
    };
    expect(savedSearch.searchSource.getField('query')).toBeUndefined();
    expect(savedSearch.searchSource.getField('filter')).toBeUndefined();
    updateSavedSearch({
      savedSearch,
      globalStateContainer: createGlobalStateContainer(),
      services: discoverServiceMock,
      state: {
        query,
        filters: [appFilter],
      },
    });
    expect(savedSearch.searchSource.getField('query')).toEqual(query);
    expect(savedSearch.searchSource.getField('filter')).toEqual([globalFilter, appFilter]);
  });

  it('should set time range is timeRestore is enabled', async () => {
    const savedSearch: SavedSearch = {
      ...savedSearchMock,
      searchSource: savedSearchMock.searchSource.createCopy(),
      timeRestore: true,
    };
    (discoverServiceMock.timefilter.getTime as jest.Mock).mockReturnValue({
      from: 'now-666m',
      to: 'now',
    });
    updateSavedSearch({
      savedSearch,
      globalStateContainer: createGlobalStateContainer(),
      services: discoverServiceMock,
      state: {
        query,
        filters: [appFilter],
      },
    });
    expect(savedSearch.timeRange).toEqual({
      from: 'now-666m',
      to: 'now',
    });
  });

  it('should not set time range if timeRestore is not enabled', async () => {
    const savedSearch: SavedSearch = {
      ...savedSearchMock,
      searchSource: savedSearchMock.searchSource.createCopy(),
      timeRestore: false,
    };
    (discoverServiceMock.timefilter.getTime as jest.Mock).mockReturnValue({
      from: 'now-666m',
      to: 'now',
    });
    updateSavedSearch({
      savedSearch,
      globalStateContainer: createGlobalStateContainer(),
      services: discoverServiceMock,
      state: {
        query,
        filters: [appFilter],
      },
    });
    expect(savedSearch.timeRange).not.toEqual({
      from: 'now-666m',
      to: 'now',
    });
  });

  it('should pass breakdownField if state has breakdownField', async () => {
    const savedSearch = {
      ...savedSearchMock,
      searchSource: savedSearchMock.searchSource.createCopy(),
    };
    expect(savedSearch.breakdownField).toBeUndefined();
    updateSavedSearch({
      savedSearch,
      globalStateContainer: createGlobalStateContainer(),
      services: discoverServiceMock,
      state: {
        breakdownField: 'test',
      },
    });
    expect(savedSearch.breakdownField).toEqual('test');
  });

  it('should pass an empty string if state already has breakdownField', async () => {
    const savedSearch = {
      ...savedSearchMock,
      searchSource: savedSearchMock.searchSource.createCopy(),
      breakdownField: 'test',
    };
    updateSavedSearch({
      savedSearch,
      globalStateContainer: createGlobalStateContainer(),
      services: discoverServiceMock,
      state: {
        breakdownField: undefined,
      },
    });
    expect(savedSearch.breakdownField).toEqual('');
  });

  it('should set query and filters from services', async () => {
    const savedSearch = {
      ...savedSearchMock,
      searchSource: savedSearchMock.searchSource.createCopy(),
    };
    expect(savedSearch.searchSource.getField('query')).toBeUndefined();
    expect(savedSearch.searchSource.getField('filter')).toBeUndefined();
    jest
      .spyOn(discoverServiceMock.data.query.filterManager, 'getFilters')
      .mockReturnValue([appFilter, globalFilter]);
    jest.spyOn(discoverServiceMock.data.query.queryString, 'getQuery').mockReturnValue(query);
    updateSavedSearch({
      savedSearch,
      globalStateContainer: createGlobalStateContainer(),
      services: discoverServiceMock,
      useFilterAndQueryServices: true,
    });
    expect(savedSearch.searchSource.getField('query')).toEqual(query);
    expect(savedSearch.searchSource.getField('filter')).toEqual([appFilter, globalFilter]);
  });
});
