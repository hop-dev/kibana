/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'perf_hooks';
import v8 from 'v8';
import { appendFileSync, getSafePath, writeFile } from '@kbn/fs';
import type { SeedReach, WalkHop } from '@kbn/graph-algorithms';

// Measurement only, for performance tests, and off unless blastRadius.runRecord is set. Each hop
// is appended as a JSON line to <data path>/blast_radius/<run id>.hops.log as it ends, so a run that dies
// shows where it ended. At the end, <run id>.json holds the phase times with the CPU and event
// loop utilisation of each, peak memory, event loop delay, and each crown jewel's relationships
// read, entities by hops and top choke points, for the correctness check outside Kibana.
// Removing it means deleting this file, the config key and its calls in the maintainer.

export type RunPhase = 'crownJewels' | 'walk' | 'compute' | 'writeBack';

interface Mark {
  readonly at: number;
  readonly cpu: NodeJS.CpuUsage;
  readonly elu: EventLoopUtilization;
}

export interface RunRecord {
  readonly hop: (hop: WalkHop) => void;
  /** Counts a page of relationships handed to the walk. */
  readonly page: () => void;
  /** Ends the walk at its last hop: what follows it, until the walk returns, is compute. */
  readonly endWalk: () => void;
  readonly endPhase: (phase: RunPhase) => void;
  /** Writes the record and returns its path. */
  readonly finish: (
    result: Record<string, unknown>,
    seeds?: readonly SeedReach[]
  ) => Promise<string>;
}

/** The folder under Kibana's data path. */
const VOLUME = 'blast_radius';
const MB = 1024 * 1024;
const SAMPLE_INTERVAL_MS = 1_000;
const TOP_CHOKE_POINTS = 5;

const megabytes = (bytes: number): number => Math.round(bytes / MB);
const seconds = (ms: number): number => Math.round(ms) / 1000;

const mark = (): Mark => ({
  at: Date.now(),
  cpu: process.cpuUsage(),
  elu: performance.eventLoopUtilization(),
});

export const startRunRecord = ({
  runId,
  namespace,
  settings,
}: {
  runId: string;
  namespace: string;
  settings: Record<string, number | boolean>;
}): RunRecord => {
  const hopsName = `${runId}.hops.log`;
  const hopsFile = getSafePath(hopsName, VOLUME).fullPath;
  const started = mark();
  const startRss = process.memoryUsage().rss;
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let peakRss = startRss;
  let peakHeap = process.memoryUsage().heapUsed;
  const sample = () => {
    const { rss, heapUsed } = process.memoryUsage();
    peakRss = Math.max(peakRss, rss);
    peakHeap = Math.max(peakHeap, heapUsed);
  };
  const sampler = setInterval(sample, SAMPLE_INTERVAL_MS);
  sampler.unref();

  const phases: Array<Record<string, unknown>> = [];
  let phaseStart = started;
  let lastHop: Mark | undefined;
  let pages = 0;

  const closePhase = (name: RunPhase, end: Mark) => {
    const elu = performance.eventLoopUtilization(end.elu, phaseStart.elu);
    phases.push({
      name,
      startedAt: new Date(phaseStart.at).toISOString(),
      endedAt: new Date(end.at).toISOString(),
      seconds: seconds(end.at - phaseStart.at),
      cpuUserSeconds: Math.round((end.cpu.user - phaseStart.cpu.user) / 1e3) / 1e3,
      cpuSystemSeconds: Math.round((end.cpu.system - phaseStart.cpu.system) / 1e3) / 1e3,
      eventLoopUtilization: Math.round(elu.utilization * 1000) / 1000,
    });
    phaseStart = end;
  };

  return {
    hop: ({ hop, frontierSize, edgesRead }) => {
      sample();
      lastHop = mark();
      const { rss, heapUsed } = process.memoryUsage();
      appendFileSync(
        hopsName,
        `${JSON.stringify({
          at: new Date(lastHop.at).toISOString(),
          hop,
          elapsedSeconds: seconds(lastHop.at - started.at),
          frontierSize,
          pages,
          relationshipsRead: edgesRead,
          rssMB: megabytes(rss),
          heapMB: megabytes(heapUsed),
        })}\n`,
        { volume: VOLUME }
      );
      pages = 0;
    },
    page: () => {
      pages++;
    },
    endWalk: () => closePhase('walk', lastHop ?? mark()),
    endPhase: (phase) => {
      sample();
      closePhase(phase, mark());
    },
    finish: async (result, seeds) => {
      clearInterval(sampler);
      sample();
      delay.disable();
      const ended = Date.now();
      const record = {
        runId,
        namespace,
        startedAt: new Date(started.at).toISOString(),
        endedAt: new Date(ended).toISOString(),
        endToEndSeconds: seconds(ended - started.at),
        settings,
        nodeOptions: process.env.NODE_OPTIONS ?? '',
        ...result,
        phases,
        memory: {
          startRssMB: megabytes(startRss),
          peakRssMB: megabytes(peakRss),
          peakHeapMB: megabytes(peakHeap),
          // maxRSS is in kilobytes, and covers the process's whole life.
          processMaxRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
          heapLimitMB: megabytes(v8.getHeapStatistics().heap_size_limit),
        },
        eventLoopDelay: {
          p99Ms: Math.round(delay.percentile(99) / 1e4) / 100,
          maxMs: Math.round(delay.max / 1e4) / 100,
        },
        hopsFile,
        crownJewels: (seeds ?? []).map(({ seedId, edgesRead, reachedByHops, chokePoints }) => ({
          id: seedId,
          relationshipsRead: edgesRead,
          reachedByHops,
          topChokeNodes: chokePoints.nodes.slice(0, TOP_CHOKE_POINTS),
          topChokeLinks: chokePoints.links.slice(0, TOP_CHOKE_POINTS),
        })),
      };
      const { path } = await writeFile(`${runId}.json`, `${JSON.stringify(record, null, 2)}\n`, {
        volume: VOLUME,
      });
      return path;
    },
  };
};
