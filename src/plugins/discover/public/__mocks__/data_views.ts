/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import { DataViewsContract } from '@kbn/data-views-plugin/public';
import { dataViewMock } from './data_view';

export const dataViewsMock = {
  getCache: async () => {
    return [dataViewMock];
  },
  get: async (id: string) => {
    if (id === 'the-data-view-id') {
      return Promise.resolve(dataViewMock);
    } else if (id === 'invalid-data-view-id') {
      return Promise.reject('Invald');
    }
  },
  updateSavedObject: jest.fn(),
} as unknown as jest.Mocked<DataViewsContract>;
