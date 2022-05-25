/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import React, { useState, useCallback } from 'react';

import type { SearchHit } from '@kbn/core/types/elasticsearch';

import type { MultiPageStepLayoutProps } from '../../types';
import { useStartServices } from '../../../../../../hooks';

import {
  ConfirmIncomingDataWithPreview,
  CreatePackagePolicyFinalBottomBar,
  NotObscuredByBottomBar,
} from '..';

export const ConfirmDataPageStep: React.FC<MultiPageStepLayoutProps> = (props) => {
  const { enrolledAgentIds, packageInfo } = props;
  const core = useStartServices();

  const [seenDataTypes, setSeenDataTypes] = useState<Array<string | undefined>>([]);
  const { docLinks } = core;
  const troubleshootLink = docLinks.links.fleet.troubleshooting;
  const setPreviewData = useCallback((previewData: SearchHit[]) => {
    const newSeenDataTypes = previewData.map((hit) => {
      const source = hit?._source as any;
      return source?.data_stream?.type || undefined;
    });

    setSeenDataTypes(newSeenDataTypes);
  }, []);
  return (
    <>
      <ConfirmIncomingDataWithPreview
        agentIds={enrolledAgentIds}
        installedPolicy={packageInfo}
        agentDataConfirmed={!!seenDataTypes.length}
        setPreviewData={setPreviewData}
        troubleshootLink={troubleshootLink}
      />

      {!!seenDataTypes.length && (
        <>
          <NotObscuredByBottomBar />
          <CreatePackagePolicyFinalBottomBar
            pkgkey={`${packageInfo.name}-${packageInfo.version}`}
            seenDataTypes={seenDataTypes}
            packageInfo={packageInfo}
          />
        </>
      )}
    </>
  );
};
