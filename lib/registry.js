// dsh-mesh: node capability registry on the shared folder.
//
// Each node writes <root>/nodes/<node>.json every heartbeatMs. The coordinator
// reads it to know which peers exist, what they can do (caps) and how many
// concurrent slots each capability allows. This is deliberately independent of
// dsh-lan-peers: as long as two machines share the folder, routing works.

import path from 'node:path';

import { ensureDir, listFiles, nowIso, readJson, safeId, writeJsonAtomic } from './store.js';

export function nodeFileName(node) {
  return `${safeId(node)}.json`;
}

export function writeHeartbeat(paths, info) {
  const file = path.join(paths.nodesDir, nodeFileName(info.node));
  ensureDir(paths.nodesDir);
  return writeJsonAtomic(file, { ...info, updatedAt: nowIso(), ts: Date.now() });
}

export function readNodes(paths, { ttlMs = 90000, now = Date.now() } = {}) {
  const out = [];
  for (const name of listFiles(paths.nodesDir)) {
    if (!name.endsWith('.json')) continue;
    const record = readJson(path.join(paths.nodesDir, name), null);
    if (!record || !record.node) continue;
    const ts = Number(record.ts || 0);
    const ageMs = ts ? now - ts : Number.POSITIVE_INFINITY;
    if (ageMs > ttlMs) continue;
    out.push({
      node: String(record.node),
      address: String(record.address || ''),
      httpPort: Number(record.httpPort || 0),
      caps: Array.isArray(record.caps) && record.caps.length ? record.caps.map(String) : ['text'],
      capSlots: record.capSlots && typeof record.capSlots === 'object' ? record.capSlots : {},
      maxConcurrent: Number(record.maxConcurrent || 1),
      role: String(record.role || 'auto'),
      ageMs,
    });
  }
  return out.sort((a, b) => a.node.localeCompare(b.node));
}
