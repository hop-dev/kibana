/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import type { Logger } from '@kbn/core/server';
import type { InferenceChatModel } from '@kbn/inference-langchain';
import { JsonOutputParser } from '@langchain/core/output_parsers';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import type { LeadEntity, Observation } from '../types';
import { entityToKey } from '../observation_modules/utils';

/** Maximum observations included per entity in the LLM prompt to keep context bounded. */
const MAX_OBSERVATIONS_PER_ENTITY = 5;

export interface ScoredEntityInput {
  readonly entity: LeadEntity;
  readonly priority: number;
  readonly observations: Observation[];
}

export interface LlmSynthesisResult {
  readonly title: string;
  readonly description: string;
  readonly tags: string[];
  readonly recommendations: string[];
}

const BATCH_SYNTHESIS_PROMPT = `You are a senior security analyst synthesizing threat hunting leads from automated observation data. Produce concise, actionable output that helps a SOC analyst quickly understand and act on each threat.

You will receive data for {lead_count} entities. Respond ONLY with a valid JSON array (no markdown fences, no extra text) containing exactly {lead_count} objects in the same order as the input, each matching this schema:
{{
  "title": "string - MAXIMUM 4 WORDS. A short threat label, not a sentence. Good: 'Anomalous behavior', 'Credential harvesting', 'Lateral movement detected'. Bad: 'Suspected Multi-Tactic Attack Targeting DevOps User'",
  "description": "string - a narrative paragraph (plain text, NO markdown, NO bold/italic markers) connecting the evidence for this entity, referencing specific data points. Do NOT use asterisks or markdown formatting.",
  "tags": ["string array - 3 to 6 tags. Use human-readable technique or rule names from the observation data only, NOT numeric IDs. Good: 'Container Escape Attempt', 'Lateral Movement'. Bad: 'T1075'."],
  "recommendations": ["string array - 3 to 5 chat prompts an analyst can paste into an AI assistant. Each must be a direct question, e.g. 'Show me the critical alerts for user \\"jsmith\\" from the last 7 days grouped by rule name'. Do NOT write generic advice."]
}}

**Entities and observations:**
{leads_payload}

Respond with the JSON array only.`;

const batchSynthesisPrompt = ChatPromptTemplate.fromTemplate(BATCH_SYNTHESIS_PROMPT);

const formatLeadsPayload = (groups: ScoredEntityInput[][]): string => {
  return groups
    .map((group, i) => {
      const entityLines = group
        .map((s) => `  - ${s.entity.type} "${s.entity.name}" (priority: ${s.priority}/10)`)
        .join('\n');

      const obsLines = group
        .flatMap((s) => {
          const key = entityToKey(s.entity);
          return s.observations
            .filter((o) => o.entityId === key)
            .slice(0, MAX_OBSERVATIONS_PER_ENTITY)
            .map((obs) => {
              const metaEntries = Object.entries(obs.metadata)
                .filter(([, v]) => v !== undefined && v !== null && v !== '')
                .slice(0, 5)
                .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
                .join(', ');
              return `  - [${obs.severity.toUpperCase()}] ${obs.description} (type=${
                obs.type
              }, score=${obs.score}/100${metaEntries ? `, ${metaEntries}` : ''})`;
            });
        })
        .join('\n');

      return `### Lead ${i + 1}\n${entityLines}\n${obsLines}`;
    })
    .join('\n\n');
};

/**
 * Use an LLM to synthesize content for all leads in a single batch call.
 * Returns results in the same order as the input groups.
 * Throws on failure so the caller can fall back to rule-based synthesis.
 */
export const llmSynthesizeBatch = async (
  chatModel: InferenceChatModel,
  groups: ScoredEntityInput[][],
  logger: Logger
): Promise<LlmSynthesisResult[]> => {
  if (groups.length === 0) return [];

  const leadsPayload = formatLeadsPayload(groups);
  const jsonParser = new JsonOutputParser<LlmSynthesisResult[]>();
  const chain = batchSynthesisPrompt.pipe(chatModel).pipe(jsonParser);

  logger.debug(`[LeadGenerationEngine] Invoking LLM for batch synthesis of ${groups.length} leads`);

  const results = await chain.invoke({
    lead_count: String(groups.length),
    leads_payload: leadsPayload,
  });

  if (!Array.isArray(results) || results.length !== groups.length) {
    throw new Error(
      `LLM batch synthesis returned ${
        Array.isArray(results) ? results.length : typeof results
      } items, expected ${groups.length}`
    );
  }

  return results.map((result) => {
    if (
      typeof result.title !== 'string' ||
      typeof result.description !== 'string' ||
      !Array.isArray(result.tags) ||
      !Array.isArray(result.recommendations)
    ) {
      throw new Error('LLM returned malformed JSON: missing required fields in batch item');
    }
    return {
      title: truncateTitle(result.title, 5),
      description: stripMarkdown(result.description),
      tags: result.tags
        .map(String)
        .filter((t) => !/^T\d{4}(\.\d{3})?$/i.test(t.trim()))
        .slice(0, 6),
      recommendations: result.recommendations.map(String).slice(0, 5),
    };
  });
};

/** Keep only the first N words of a title so card headings stay short. */
const truncateTitle = (title: string, maxWords: number): string => {
  const words = title.trim().split(/\s+/);
  if (words.length <= maxWords) {
    return title.trim();
  }
  return words.slice(0, maxWords).join(' ');
};

/** Remove markdown bold/italic/heading markers so descriptions render as plain text. */
const stripMarkdown = (text: string): string =>
  text
    .replace(/#{1,6}\s*/g, '')
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    .replace(/_{1,3}([^_]+)_{1,3}/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
