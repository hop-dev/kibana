/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React from 'react';
import { EuiInMemoryTable } from '@elastic/eui';
import type { EuiBasicTableColumn } from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import { FormattedMessage } from '@kbn/i18n-react';
import { useUiSetting$ } from '@kbn/kibana-react-plugin/public';
import type { EntityRiskScoreRecord } from '../../../../common/api/entity_analytics/common';
import type { RiskSeverity } from '../../../../common/search_strategy';
import { FF_ENABLE_ENTITY_STORE_V2 } from '../../../../common/entity_analytics/entity_store/constants';
import { RiskScoreLevel } from '../severity/common';
import { EntityDetailsLink } from '../../../common/components/links';
import type { EntityType } from '../../../../common/entity_analytics/types';

type RiskScoreColumn = EuiBasicTableColumn<EntityRiskScoreRecord> & {
  field: keyof EntityRiskScoreRecord;
};

export const RiskScorePreviewTable = ({
  items,
  type,
}: {
  items: EntityRiskScoreRecord[];
  type: EntityType;
}) => {
  const [entityStoreV2Enabled] = useUiSetting$<boolean>(FF_ENABLE_ENTITY_STORE_V2);
  const nameColumnTitle = entityStoreV2Enabled ? (
    <FormattedMessage
      id="xpack.securitySolution.riskScore.previewTable.idColumnTitle"
      defaultMessage="ID"
    />
  ) : (
    <FormattedMessage
      id="xpack.securitySolution.riskScore.previewTable.nameColumnTitle"
      defaultMessage="Name"
    />
  );

  const columns: RiskScoreColumn[] = [
    {
      field: 'id_value',
      name: nameColumnTitle,
      render: (entityName: string) => (
        <EntityDetailsLink entityName={entityName} entityType={type} />
      ),
    },
    {
      field: 'calculated_level',
      name: (
        <FormattedMessage
          id="xpack.securitySolution.riskScore.previewTable.levelColumnTitle"
          defaultMessage="Level"
        />
      ),

      render: (risk: RiskSeverity | null) => {
        if (risk != null) {
          return <RiskScoreLevel severity={risk} />;
        }

        return '';
      },
    },
    {
      field: 'calculated_score_norm',
      name: (
        <FormattedMessage
          id="xpack.securitySolution.riskScore.previewTable.scoreNormColumnTitle"
          defaultMessage="Score norm"
        />
      ),
      render: (scoreNorm: number | null) => {
        if (scoreNorm != null) {
          return Math.round(scoreNorm * 100) / 100;
        }
        return '';
      },
    },
  ];

  return (
    <EuiInMemoryTable<EntityRiskScoreRecord>
      data-test-subj={`${type}-risk-preview-table`}
      responsiveBreakpoint={false}
      items={items}
      columns={columns}
      tableCaption={i18n.translate('xpack.securitySolution.riskScore.previewTable.caption', {
        defaultMessage: 'Entity risk score preview',
      })}
    />
  );
};
