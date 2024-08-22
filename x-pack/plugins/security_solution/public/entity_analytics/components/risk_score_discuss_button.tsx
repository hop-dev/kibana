/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useCallback, useMemo } from 'react';
import { i18n } from '@kbn/i18n';
import { EuiToolTip, EuiButtonIcon } from '@elastic/eui';
import { useAssistantOverlay } from '@kbn/elastic-assistant';
import type { SearchHit } from '@kbn/es-types';
import type { Alert } from '@kbn/alerting-types';
import _ from 'lodash';
import {
  type UserRiskScore,
  type HostRiskScore,
  isUserRiskScore,
} from '../../../common/search_strategy';
import { useAssistantAvailability } from '../../assistant/use_assistant_availability';
import { fetchQueryAlerts } from '../../detections/containers/detection_engine/alerts/api';
import type { AlertSearchResponse } from '../../detections/containers/detection_engine/alerts/types';

interface RiskScoreDiscussButtonComponentProps {
  riskScore?: UserRiskScore | HostRiskScore;
}

// TODO: move this to a shared location with better ID
const NEW_CHAT = i18n.translate(
  'xpack.elasticAssistant.assistant.conversations.sidePanel.newChatButtonLabel',
  {
    defaultMessage: 'Discuss risk score with Elastic Assistant',
  }
);

const formatAlertForPrompt = ({ _source: alert }: SearchHit<Alert>) => {
  return JSON.stringify(
    _.omit(alert, [
      'kibana.alert.rule.revision',
      'kibana.alert.rule.immutable',
      'kibana.alert.depth',
      'kibana.alert.rule.enabled',
      'kibana.alert.rule.version',
      'kibana.alert.rule.type',
      'kibana.alert.start',
      'event.kind',
      'kibana.alert.workflow_status',
      'kibana.alert.rule.uuid',
      'kibana.alert.rule.risk_score_mapping',
      'kibana.alert.rule.interval',
      'kibana.alert.url',
      'kibana.alert.rule.description',
      'host.hostname',
      'kibana.alert.rule.tags',
      'kibana.alert.rule.producer',
      'kibana.alert.rule.to',
      'kibana.alert.rule.references',
      'kibana.alert.rule.updated_by',
      'kibana.alert.case_ids',
      'kibana.alert.original_event.agent_id_status',
      'kibana.alert.original_event.ingested',
      'kibana.alert.original_event.id',
      'kibana.alert.original_event.kind',
      'kibana.alert.original_event.module',
      'kibana.alert.original_event.dataset',
      'kibana.alert.rule.created_at',
      'kibana.alert.rule.created_by',
      'kibana.alert.rule.exceptions_list',
      'kibana.alert.rule.false_positives',
      'kibana.alert.rule.from',
      'kibana.alert.rule.indices',
      'kibana.alert.rule.license',
      'kibana.alert.rule.max_signals',
      'kibana.alert.rule.rule_id',
      'kibana.alert.rule.rule_name_override',
      'kibana.alert.rule.severity_mapping',
      'kibana.alert.rule.threat',
      'kibana.alert.rule.updated_at',
      'kibana.alert.uuid',
      'kibana.alert.workflow_tags',
      'kibana.alert.workflow_assignee_ids',
      'kibana.alert.rule.meta.from',
      'kibana.alert.rule.meta.kibana_siem_app_url',
      'kibana.alert.ancestors',
      'group',
      'event.agent_id_status',
      'ecs',
      'cloud',
      'agent',
      'kibana.alert.workflow_status_updated_at',
      'kibana.alert.rule.name',
      'kibana.alert.rule.parameters',
      'tags',
      'sentinel_one_cloud_funnel.event.src',
      'log',
      'kibana.alert.last_detected',
      'related',
      'data_stream',
      'gcs',
      'kibana.alert.workflow_user',
      'elastic_agent',
      'kibana.alert.rule.author',
      'kibana.alert.rule.consumer',
      'kibana.space_ids',
      'event.dataset',
      'kibana.alert.original_time',
    ])
  );
};

const formatPromptContext = ({
  entityName,
  entityType,
  alerts,
  score,
  level,
}: {
  entityName: string;
  entityType: string;
  level: string;
  alerts: AlertSearchResponse<SearchHit<Alert>, unknown>;
  score: number;
}): string => {
  return `
    A risk score of ${score} of a possible 100 has been assigned to ${entityType} ${entityName} making them ${level} risk. The score was calclculated using a reimann zeta function where the input is the sum of the risk scores of the following alerts:

    ${alerts.hits.hits.map(formatAlertForPrompt).join('\n')}

    Do not mention riemann zeta, but provide a high level overview of the process.
    `;
};

const getPromptDetails = ({
  entityType,
  entityName,
}: {
  entityType: string;
  entityName: string;
}) => {
  return {
    title: i18n.translate('xpack.securitySolution.riskScoreDiscussButton.title', {
      defaultMessage: 'Risk score for {entityType} {entityName}',
      values: {
        entityType,
        entityName,
      },
    }),
    prompt: i18n.translate('xpack.securitySolution.riskScoreDiscussButton.prompt', {
      defaultMessage:
        'Why does the {entityType} {entityName} have this risk score? What are the primary concerns?',
      values: {
        entityType,
        entityName,
      },
    }),
  };
};

const getInputIds = (riskScore?: UserRiskScore | HostRiskScore) => {
  if (!riskScore) {
    return [];
  }

  if (isUserRiskScore(riskScore)) {
    return riskScore.user.risk.inputs.map((input) => input.id);
  }

  return riskScore.host.risk.inputs.map((input) => input.id);
};

const getScoreParts = (
  riskScore?: UserRiskScore | HostRiskScore
): {
  score: number;
  entityType: string;
  entityName: string;
  level: string;
  inputIds: string[];
} => {
  if (!riskScore) {
    return { score: 0, entityType: '', entityName: '', level: '', inputIds: [] };
  }

  const entityType = isUserRiskScore(riskScore) ? 'user' : 'host';
  const entityName = isUserRiskScore(riskScore) ? riskScore.user.name : riskScore.host.name;
  const score = isUserRiskScore(riskScore)
    ? riskScore.user.risk.calculated_score
    : riskScore.host.risk.calculated_score;
  const level = isUserRiskScore(riskScore)
    ? riskScore.user.risk.calculated_level
    : riskScore.host.risk.calculated_level;
  const inputIds = getInputIds(riskScore);
  return { score, entityType, entityName, level, inputIds };
};

const RiskScoreDiscussButtonComponent = ({ riskScore }: RiskScoreDiscussButtonComponentProps) => {
  const { hasAssistantPrivilege, isAssistantEnabled } = useAssistantAvailability();

  const { score, entityType, entityName, level, inputIds } = useMemo(
    () => getScoreParts(riskScore),
    [riskScore]
  );
  const { title, prompt } = useMemo(
    () => getPromptDetails({ entityName, entityType }),
    [entityName, entityType]
  );

  const getPromptContext = useCallback(async () => {
    const abortCtrl = new AbortController();
    const alerts = await fetchQueryAlerts<SearchHit<Alert>, unknown>({
      query: {
        query: {
          ids: {
            values: inputIds,
          },
        },
        sort: [
          {
            'kibana.alert.risk_score': {
              order: 'desc',
            },
          },
          {
            '@timestamp': {
              order: 'desc',
            },
          },
        ],
      },
      signal: abortCtrl.signal,
    });

    return formatPromptContext({
      entityName,
      entityType,
      alerts,
      score,
      level,
    });
  }, [entityName, entityType, inputIds, level, score]);

  const { promptContextId, showAssistantOverlay: showOverlay } = useAssistantOverlay(
    'alerts', // category
    title, // conversation title
    title, // description used in context pill
    getPromptContext,
    null, // accept the UUID default for this prompt context
    prompt, // prompt
    null, // tooltip
    isAssistantEnabled,
    null // replacements
  );

  const showAssistantOverlay = () => showOverlay(true, true);

  const isDisabled = !hasAssistantPrivilege || promptContextId == null;

  return (
    <EuiToolTip content={NEW_CHAT}>
      <EuiButtonIcon
        disabled={isDisabled}
        data-test-subj="risk-score-discuss-button"
        iconType={'discuss'}
        onClick={showAssistantOverlay}
        color={'text'}
        aria-label={NEW_CHAT}
      />
    </EuiToolTip>
  );
};

export const RiskScoreDiscussButton = React.memo(RiskScoreDiscussButtonComponent);
