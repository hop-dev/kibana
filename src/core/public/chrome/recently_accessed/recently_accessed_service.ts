/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */

import { Observable } from 'rxjs';
import type { HttpSetup } from '@kbn/core-http-browser';

import { PersistedLog } from './persisted_log';
import { createLogKey } from './create_log_key';

/** @public */
export interface ChromeRecentlyAccessedHistoryItem {
  link: string;
  label: string;
  id: string;
}

interface StartDeps {
  http: HttpSetup;
}

/** @internal */
export class RecentlyAccessedService {
  async start({ http }: StartDeps): Promise<ChromeRecentlyAccessed> {
    const logKey = await createLogKey('recentlyAccessed', http.basePath.get());
    const history = new PersistedLog<ChromeRecentlyAccessedHistoryItem>(logKey, {
      maxLength: 20,
      isEqual: (oldItem, newItem) => oldItem.id === newItem.id,
    });

    return {
      /** Adds a new item to the history. */
      add: (link: string, label: string, id: string) => {
        history.add({
          link,
          label,
          id,
        });
      },

      /** Gets the current array of history items. */
      get: () => history.get(),

      /** Gets an observable of the current array of history items. */
      get$: () => history.get$(),
    };
  }
}

/**
 * {@link ChromeRecentlyAccessed | APIs} for recently accessed history.
 * @public
 */
export interface ChromeRecentlyAccessed {
  /**
   * Adds a new item to the recently accessed history.
   *
   * @example
   * ```js
   * chrome.recentlyAccessed.add('/app/map/1234', 'Map 1234', '1234');
   * ```
   *
   * @param link a relative URL to the resource (not including the {@link HttpStart.basePath | `http.basePath`})
   * @param label the label to display in the UI
   * @param id a unique string used to de-duplicate the recently accessed list.
   */
  add(link: string, label: string, id: string): void;

  /**
   * Gets an Array of the current recently accessed history.
   *
   * @example
   * ```js
   * chrome.recentlyAccessed.get().forEach(console.log);
   * ```
   */
  get(): ChromeRecentlyAccessedHistoryItem[];

  /**
   * Gets an Observable of the array of recently accessed history.
   *
   * @example
   * ```js
   * chrome.recentlyAccessed.get$().subscribe(console.log);
   * ```
   */
  get$(): Observable<ChromeRecentlyAccessedHistoryItem[]>;
}
