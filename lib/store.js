// dsh-mesh: shared-folder store primitives.
// Design rules:
//  - one writer per file (append-only ledger per node, exclusive-create commits)
//  - no network filesystem locks: leases are exclusive-create files + expiry
//  - every write is atomic (tmp + rename) or exclusive (wx)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

export function safeId(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
  return value;
}

export function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return file;
}

// Returns true only for the caller that created the file.
export function writeOnceJson(file, value) {
  ensureDir(path.dirname(file));
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

export function appendJsonl(file, record) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

export function readJsonl(file, limit = 2000) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  const slice = lines.length > limit ? lines.slice(lines.length - limit) : lines;
  const out = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* ignore torn tail line */
    }
  }
  return out;
}

export function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function listFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

export function removeFile(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

export function buildPaths(root) {
  const join = (...parts) => path.join(root, ...parts);
  return {
    root,
    coordLease: join('coord', 'lease.json'),
    coordDir: join('coord'),
    nodesDir: join('nodes'),
    nodeFile: (node) => join('nodes', `${safeId(node)}.json`),
    ledgerDir: (node) => join('ledger', safeId(node)),
    ledgerFile: (node) => join('ledger', safeId(node), 'events.jsonl'),
    tasksDir: join('tasks'),
    taskDir: (taskId) => join('tasks', safeId(taskId)),
    taskMeta: (taskId) => join('tasks', safeId(taskId), 'task.json'),
    plan: (taskId) => join('tasks', safeId(taskId), 'plan.json'),
    taskResult: (taskId) => join('tasks', safeId(taskId), 'result.json'),
    stepsDir: (taskId) => join('tasks', safeId(taskId), 'steps'),
    stepDir: (taskId, stepId) => join('tasks', safeId(taskId), 'steps', safeId(stepId)),
    stepState: (taskId, stepId) => join('tasks', safeId(taskId), 'steps', safeId(stepId), 'state.json'),
    stepAssign: (taskId, stepId) => join('tasks', safeId(taskId), 'steps', safeId(stepId), 'assign.json'),
    stepLease: (taskId, stepId) => join('tasks', safeId(taskId), 'steps', safeId(stepId), 'lease.json'),
    stepCommit: (taskId, stepId) => join('tasks', safeId(taskId), 'steps', safeId(stepId), 'commit.json'),
    attemptDir: (taskId, stepId, attempt) =>
      join('tasks', safeId(taskId), 'steps', safeId(stepId), 'attempts', String(attempt)),
  };
}

export function leaseActive(lease, now = Date.now()) {
  return Boolean(lease && Number(lease.expiry) > now);
}

// Exclusive-create lease. Expired leases are reclaimed by removing then creating.
export function tryTakeLease(file, owner, ttlMs) {
  const current = readJson(file, null);
  const now = Date.now();
  if (leaseActive(current, now) && current.owner !== owner) return false;
  if (current && !leaseActive(current, now)) removeFile(file);
  return writeOnceJson(file, { owner, expiry: now + ttlMs, takenAt: nowIso() });
}

export function renewLease(file, owner, ttlMs) {
  const current = readJson(file, null);
  if (!current || current.owner !== owner) return false;
  current.expiry = Date.now() + ttlMs;
  current.renewedAt = nowIso();
  writeJsonAtomic(file, current);
  return true;
}

export function releaseLease(file) {
  return removeFile(file);
}

export function leaseOwner(file) {
  const lease = readJson(file, null);
  return leaseActive(lease) ? lease.owner : null;
}
