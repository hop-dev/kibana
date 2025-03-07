/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0 and the Server Side Public License, v 1; you may not use this file except
 * in compliance with, at your election, the Elastic License 2.0 or the Server
 * Side Public License, v 1.
 */
import { FtrProviderContext } from '../../ftr_provider_context';

export default function ({ getService, loadTestFile }: FtrProviderContext) {
  const esArchiver = getService('esArchiver');
  const browser = getService('browser');
  const config = getService('config');

  describe('discover app', function () {
    before(async function () {
      await browser.setWindowSize(1300, 800);
    });

    after(async function unloadMakelogs() {
      await esArchiver.unload('test/functional/fixtures/es_archiver/logstash_functional');
    });

    if (config.get('esTestCluster.ccs')) {
      loadTestFile(require.resolve('./_data_view_editor'));
      loadTestFile(require.resolve('./_saved_queries'));
    } else {
      loadTestFile(require.resolve('./_no_data'));
      loadTestFile(require.resolve('./_saved_queries'));
      loadTestFile(require.resolve('./_discover'));
      loadTestFile(require.resolve('./_discover_accessibility'));
      loadTestFile(require.resolve('./_discover_histogram'));
      loadTestFile(require.resolve('./_doc_accessibility'));
      loadTestFile(require.resolve('./classic/_doc_table'));
      loadTestFile(require.resolve('./classic/_doc_table_newline'));
      loadTestFile(require.resolve('./_filter_editor'));
      loadTestFile(require.resolve('./_errors'));
      loadTestFile(require.resolve('./_field_data'));
      loadTestFile(require.resolve('./classic/_field_data'));
      loadTestFile(require.resolve('./_field_data_with_fields_api'));
      loadTestFile(require.resolve('./classic/_field_data_with_fields_api'));
      loadTestFile(require.resolve('./_shared_links'));
      loadTestFile(require.resolve('./_sidebar'));
      loadTestFile(require.resolve('./_source_filters'));
      loadTestFile(require.resolve('./_large_string'));
      loadTestFile(require.resolve('./_inspector'));
      loadTestFile(require.resolve('./classic/_classic_table_doc_navigation'));
      loadTestFile(require.resolve('./_date_nanos'));
      loadTestFile(require.resolve('./_date_nanos_mixed'));
      loadTestFile(require.resolve('./_indexpattern_without_timefield'));
      loadTestFile(require.resolve('./classic/_discover_fields_api'));
      loadTestFile(require.resolve('./_discover_fields_api'));
      loadTestFile(require.resolve('./_data_grid'));
      loadTestFile(require.resolve('./_data_grid_context'));
      loadTestFile(require.resolve('./_data_grid_field_data'));
      loadTestFile(require.resolve('./_data_grid_doc_navigation'));
      loadTestFile(require.resolve('./_data_grid_row_navigation'));
      loadTestFile(require.resolve('./_data_grid_doc_table'));
      loadTestFile(require.resolve('./_data_grid_copy_to_clipboard'));
      loadTestFile(require.resolve('./_data_grid_pagination'));
      loadTestFile(require.resolve('./_sql_view'));
      loadTestFile(require.resolve('./_indexpattern_with_unmapped_fields'));
      loadTestFile(require.resolve('./_runtime_fields_editor'));
      loadTestFile(require.resolve('./_huge_fields'));
      loadTestFile(require.resolve('./_date_nested'));
      loadTestFile(require.resolve('./_search_on_page_load'));
      loadTestFile(require.resolve('./_chart_hidden'));
      loadTestFile(require.resolve('./_context_encoded_url_params'));
      loadTestFile(require.resolve('./_data_view_editor'));
      loadTestFile(require.resolve('./_hide_announcements'));
      loadTestFile(require.resolve('./classic/_hide_announcements'));
      loadTestFile(require.resolve('./embeddable/saved_search_embeddable'));
    }
  });
}
