/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Maps an ESQL result row (array) to an object using the columns array.
 *
 * @param row - The ESQL result row (array of values)
 * @param columns - The columns array (with .name property)
 * @returns Record<string, any> mapping column names to values
 */
export function esqlRowToObject<T = Record<string, any>>(
  row: unknown[],
  columns: Array<{ name: string }>
): T {
  const obj: Record<string, any> = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i].name] = row[i];
  }
  return obj as T;
}
