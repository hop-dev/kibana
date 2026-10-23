/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

/**
 * Local preview of the Entity Analytics AI brief.
 *
 * Renders the real Mustache templates with content.json. Nothing here is served by Kibana.
 *
 *   node render.mjs /absolute/path/to/brief
 *
 * If this folder sits inside that brief directory, the path can be omitted.
 * Open http://127.0.0.1:4319
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const briefDir = path.resolve(process.argv[2] ?? path.join(here, '..'));
const templatePath = path.join(briefDir, 'brief.mustache.html');
const cssPath = path.join(briefDir, 'brief.css');
const chartPath = path.join(briefDir, 'risk_history_chart.mustache.html');
const contentPath = path.join(here, 'content.json');

if (!fs.existsSync(templatePath)) {
  console.error(`No brief template at ${templatePath}`);
  console.error('Pass the brief directory: node render.mjs /path/to/entity_analytics/brief');
  process.exit(1);
}

const require = createRequire(path.join(briefDir, 'package.json'));
const Mustache = require('mustache');

const escapeHtml = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\{/g, '&#123;');

const read = (file) => fs.readFileSync(file, 'utf8');

const renderBrief = (scenarioName) => {
  const { scenarios } = JSON.parse(read(contentPath));
  const scenario = scenarios[scenarioName] ?? scenarios.typical;
  return Mustache.render(
    read(templatePath),
    { ...scenario, css: read(cssPath) },
    { riskHistoryChart: read(chartPath) },
    { escape: escapeHtml }
  );
};

const stamp = () =>
  [templatePath, cssPath, chartPath, contentPath].map((file) => fs.statSync(file).mtimeMs).join(',');

const page = (scenarioName) => `<!doctype html>
<html data-theme="light">
<head>
  <meta charset="utf-8">
  <title>AI brief preview</title>
  <style>
    :root {
      --cc-color-text: #343741;
      --cc-color-background: transparent;
      --cc-color-surface: #fff;
      --cc-color-primary: #07c;
      --cc-color-accent: #00bfb3;
      --cc-color-warning: #f5a700;
      --cc-color-danger: #bd271e;
      --cc-color-border: #d3dae6;
      --cc-radius: 6px;
      --cc-radius-s: 4px;
      --cc-space-l: 16px;
      --cc-font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      --cc-vis-0: #54b399;
      --cc-vis-1: #6092c0;
      --cc-vis-2: #d36086;
      --cc-vis-3: #9170b8;
      --cc-vis-4: #ca8eae;
      --cc-vis-5: #d6bf57;
      --page: #f7f8fc;
      --chrome: #343741;
    }
    html[data-theme="dark"] {
      --cc-color-text: #dfe5ef;
      --cc-color-background: #1d1e24;
      --cc-color-surface: #25262e;
      --cc-color-primary: #36a2ef;
      --cc-color-accent: #7dded8;
      --cc-color-warning: #ffce7a;
      --cc-color-danger: #f66;
      --cc-color-border: #343741;
      --page: #141519;
      --chrome: #dfe5ef;
    }
    body { margin: 0; background: var(--page); color: var(--chrome); font: 13px/1.4 var(--cc-font-family); }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 12px 16px; }
    .toolbar a, .toolbar button { color: inherit; font: inherit; background: transparent; border: 1px solid var(--cc-color-border); border-radius: 4px; padding: 2px 8px; cursor: pointer; text-decoration: none; }
    .toolbar .hint { opacity: 0.7; }
    .stage { position: relative; width: min(800px, calc(100% - 32px)); margin: 0 16px 32px; }
    .frame {
      background: var(--cc-color-background);
      color: var(--cc-color-text);
      padding: var(--cc-space-l);
      border: 1px solid var(--cc-color-border);
      border-radius: 6px;
      box-sizing: border-box;
    }
    html[data-theme="light"] .frame { background: #fff; }
    .fold {
      position: absolute; z-index: 2; left: 0; right: 0; top: 1200px;
      border-top: 1px dashed var(--cc-color-danger); pointer-events: none;
    }
    .fold span {
      position: absolute; right: 0; top: 4px; font-size: 11px; font-weight: 700;
      letter-spacing: 0.04em; text-transform: uppercase; color: var(--cc-color-danger);
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <strong>AI brief</strong>
    <a href="?scenario=typical">Typical</a>
    <a href="?scenario=dense">Dense</a>
    <button type="button" data-theme="light">Light</button>
    <button type="button" data-theme="dark">Dark</button>
    <span class="hint">Template, CSS, and content.json reload this page. The line is the 1200px card; what falls below it scrolls.</span>
  </div>
  <div class="stage">
    <div class="fold"><span>1200px</span></div>
    <div class="frame">${renderBrief(scenarioName)}</div>
  </div>
  <script>
    const saved = localStorage.getItem('brief-theme');
    if (saved) document.documentElement.dataset.theme = saved;
    document.querySelectorAll('.toolbar [data-theme]').forEach((button) => {
      button.addEventListener('click', () => {
        document.documentElement.dataset.theme = button.dataset.theme;
        localStorage.setItem('brief-theme', button.dataset.theme);
      });
    });
    let seen = ${JSON.stringify(stamp())};
    setInterval(async () => {
      const next = await fetch('/__mtime').then((response) => response.text());
      if (seen && next !== seen) location.reload();
      seen = next;
    }, 400);
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/__mtime') {
    res.setHeader('content-type', 'text/plain');
    res.end(stamp());
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  try {
    res.end(page(url.searchParams.get('scenario') || 'typical'));
  } catch (error) {
    res.statusCode = 500;
    res.end(`<pre>${escapeHtml(error.stack ?? error.message)}</pre>`);
  }
});

server.listen(4319, '127.0.0.1', () => {
  console.log('AI brief preview at http://127.0.0.1:4319');
  console.log(`Templates: ${briefDir}`);
});
