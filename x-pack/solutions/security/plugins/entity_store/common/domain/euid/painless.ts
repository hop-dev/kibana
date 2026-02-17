/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { EntityType, EuidAttribute } from '../definitions/entity_schema';
import { getEntityDefinitionWithoutId } from '../definitions/registry';
import { isEuidField, isEuidSeparator } from './commons';

/** Identity field names that are typically defined as runtime fields in the same request; script must not reference them to avoid circular/unsupported doc lookup. */
const RUNTIME_IDENTITY_FIELDS = new Set([
  'host.entity.id',
  'user.entity.id',
  'service.entity.id',
  'entity.id',
]);

/**
 * Returns an Elasticsearch runtime keyword field mapping whose Painless script
 * computes the typed EUID for the given entity type.
 *
 * The script wraps {@link getEuidPainlessEvaluation} in a
 * small helper so the value is emitted via `emit()` as required by keyword
 * runtime fields. When used in composite aggs, use a runtime field name other
 * than ECS identity fields (e.g. risk_score.entity_id.user) so the script can
 * safely reference doc['user.entity.id'] from the document.
 *
 * Example usage:
 * ```ts
 * runtime_mappings: { 'risk_score.entity_id.user': getEuidPainlessRuntimeMapping('user') }
 * ```
 *
 * @param entityType - The entity type string (e.g. 'host', 'user', 'generic')
 * @returns A runtime keyword field mapping (type + script) for use in runtime_mappings.
 */
export function getEuidPainlessRuntimeMapping(entityType: EntityType): {
  type: 'keyword';
  script: { source: string };
} {
  const returnScript = getEuidPainlessEvaluation(entityType);
  const emitScript = `String euid_eval(def doc) { ${returnScript} } def result = euid_eval(doc); if (result != null) { emit(result); }`;
  return {
    type: 'keyword',
    script: { source: emitScript },
  };
}

/**
 * Options for getEuidPainlessEvaluation.
 * @property forRuntimeField - When true, omit clauses that reference identity fields (host.entity.id, user.entity.id, etc.) so the script is safe to use as a runtime field that defines one of those fields (avoids circular doc lookup in composite aggs).
 */
export type GetEuidPainlessEvaluationOptions = { forRuntimeField?: boolean };

/**
 * Constructs a Painless evaluation for the provided entity type to generate the entity id.
 *
 * To use in a runtime field, you can wrap the generation around a function and emit the value.
 * Use forRuntimeField: true when the script will define an identity field (e.g. host.entity.id) so it does not reference that or other identity fields.
 *
 * Example usage:
 * ```ts
 * import { getEuidPainlessEvaluation } from './painless';
 *
 * const evaluation = getEuidPainlessEvaluation('host');
 * // evaluation may look like:
 * // 'if (doc.containsKey('host.name') && doc['host.name'].size() > 0 && doc['host.name'].value != null && doc['host.name'].value != "") { return "host:" + doc['host.name'].value; } return null;'
 * ```
 *
 * @param entityType - The entity type string (e.g. 'host', 'user', 'generic')
 * @param options - forRuntimeField: omit clauses that reference identity fields (for use as runtime field script)
 * @returns A Painless evaluation string that computes the entity id.
 */
export function getEuidPainlessEvaluation(
  entityType: EntityType,
  options: GetEuidPainlessEvaluationOptions = {}
): string {
  const { forRuntimeField = false } = options;
  const { identityField } = getEntityDefinitionWithoutId(entityType);

  const euidFieldsFiltered = forRuntimeField
    ? identityField.euidFields.filter(
        (composedField) =>
          !composedField.some(
            (attr) => isEuidField(attr) && RUNTIME_IDENTITY_FIELDS.has(attr.field)
          )
      )
    : identityField.euidFields;

  if (euidFieldsFiltered.length === 0) {
    throw new Error('No euid fields found, invalid euid logic definition');
  }

  if (euidFieldsFiltered.length === 1) {
    const first = euidFieldsFiltered[0][0];
    if (isEuidSeparator(first)) {
      throw new Error('Separator found in single field, invalid euid logic definition');
    }
    const field = first.field;
    const condition = painlessFieldNonEmpty(field);
    const valueExpr = `doc['${escapePainlessField(field)}'].value`;
    return `if (${condition}) { return "${entityType}:" + ${valueExpr}; } return null;`;
  }

  const prefix = `"${entityType}:"`;
  const clauses = euidFieldsFiltered.map((composedField) => {
    const condition = buildPainlessCondition(composedField);
    const valueExpr = buildPainlessValueExpr(composedField);
    return `if (${condition}) { return ${prefix} + ${valueExpr}; }`;
  });

  return clauses.join(' ') + ' return null;';
}

function painlessFieldNonEmpty(field: string): string {
  const escaped = escapePainlessField(field);
  return `doc.containsKey('${escaped}') && doc['${escaped}'].size() > 0 && doc['${escaped}'].value != null && doc['${escaped}'].value != ""`;
}

function buildPainlessCondition(composedField: EuidAttribute[]): string {
  const fieldAttrs = composedField.filter((attr) => isEuidField(attr));
  return fieldAttrs.map((a) => painlessFieldNonEmpty(a.field)).join(' && ');
}

function buildPainlessValueExpr(composedField: EuidAttribute[]): string {
  if (composedField.length === 1 && isEuidField(composedField[0])) {
    return `doc['${escapePainlessField(composedField[0].field)}'].value`;
  }
  const parts = composedField.map((attr) => {
    if (isEuidField(attr)) {
      return `doc['${escapePainlessField(attr.field)}'].value`;
    }
    return `"${escapePainlessString(attr.separator)}"`;
  });
  return parts.join(' + ');
}

function escapePainlessField(field: string): string {
  return field.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapePainlessString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
