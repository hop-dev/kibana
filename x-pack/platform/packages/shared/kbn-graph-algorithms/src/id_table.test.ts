/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { packedIdTable } from './id_table';

describe('packedIdTable', () => {
  it('keeps every id and its number as the table grows past its first size', () => {
    const table = packedIdTable();
    const idOf = (i: number) => `user:someone.${i}@example.com@okta`;
    // More than 2^20 ids, so the slots grow and every id is placed again.
    const count = 1_100_000;
    let misnumbered = 0;
    for (let i = 0; i < count; i++) if (table.intern(idOf(i)) !== i) misnumbered++;

    expect(misnumbered).toBe(0);

    expect(table.size()).toBe(count);
    for (const i of [0, 1, 524_287, 1_048_575, 1_048_576, count - 1]) {
      expect(table.get(idOf(i))).toBe(i);
      expect(table.intern(idOf(i))).toBe(i);
      expect(table.nameOf(i)).toBe(idOf(i));
    }
    expect(table.get('user:nobody@example.com@okta')).toBeUndefined();
  });
});
