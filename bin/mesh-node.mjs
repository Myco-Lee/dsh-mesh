#!/usr/bin/env node
// Standalone mesh node: runs the same runtime as the plugin without a DSH host.
// Useful for headless servers, CI, or when the desktop host cannot be restarted.
//
//   node bin/mesh-node.mjs --root "\\\\192.168.8.164\\dsh-mesh" --node LMM-1 \
//        --role auto --profile mesh-worker --concurrency 2

import process from 'node:process';
import { apply } from '../lib/index.js';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const config = {
  enabled: true,
  root: arg('root'),
  node: arg('node'),
  role: arg('role', 'auto'),
  workerProfile: arg('profile', 'mesh-worker'),
  maxConcurrent: Number(arg('concurrency', '2')),
  pollMs: Number(arg('poll', '2000')),
  dshExe: arg('exe'),
  dshCli: arg('cli'),
  apiKeyFile: arg('key-file'),
};

if (!config.root) {
  console.error('mesh-node: --root is required');
  process.exit(2);
}

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
};

const runtime = apply(ctx, config);
const startedAt = new Date().toISOString();
console.log(`[mesh-node] node=${config.node} root=${config.root} role=${config.role} started=${startedAt}`);

let ticks = 0;
setInterval(() => {
  ticks += 1;
  const snap = runtime.snapshot();
  console.log(
    `[mesh-node] t=${ticks} coord=${snap.coordinator || '-'} peers=${snap.peers.length} active=${snap.activeSteps} tasks=${JSON.stringify(snap.tasks)}`,
  );
}, 30000).unref();

function shutdown(signal) {
  console.log(`[mesh-node] ${signal} -> stopping`);
  try {
    runtime.stop();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
