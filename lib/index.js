// dsh-mesh — durable task mesh for DeepSeek Harness.
//
// Model: a shared folder is the durable substrate (no locks over SMB):
//   <root>/tasks/<task>/plan.json          plan written once by the submitter
//   <root>/tasks/<task>/steps/<id>/assign.json   coordinator decision
//   <root>/tasks/<task>/steps/<id>/lease.json    exclusive-create, expires
//   <root>/tasks/<task>/steps/<id>/commit.json   exclusive-create, once
//   <root>/ledger/<node>/events.jsonl      append-only, one writer per node
//   <root>/coord/lease.json                single coordinator, expires
//
// Guarantees: a committed step never runs twice; a crashed worker's lease
// expires and the step is re-dispatched elsewhere (anti-affinity); the
// coordinator itself is only a lease holder, so its death costs ~15s.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendJsonl,
  buildPaths,
  ensureDir,
  exists,
  leaseActive,
  listDirs,
  nowIso,
  readJson,
  releaseLease,
  removeFile,
  renewLease,
  sha256,
  tryTakeLease,
  writeJsonAtomic,
  writeOnceJson,
  writeTextAtomic,
} from './store.js';
import { committedText, isReady, normalizePlan, pickNode, stepState, taskSummary, DEFAULT_CAPS } from './plan.js';
import { runStep } from './exec.js';
import { readNodes, writeHeartbeat } from './registry.js';
import { TEMPLATE_NAMES, buildTemplate } from './templates.js';

export const name = 'dsh-mesh';

const DEFAULTS = {
  enabled: true,
  root: '',
  node: '',
  role: 'auto',
  pollMs: 2000,
  leaseMs: 45000,
  leaseRenewMs: 10000,
  coordLeaseMs: 15000,
  maxConcurrent: 2,
  maxAttempts: 3,
  stepTimeoutMs: 900000,
  workerProfile: 'mesh-worker',
  dshExe: '',
  dshCli: '',
  peersFile: '',
  caps: DEFAULT_CAPS,
  capSlots: {},
  maxQueuedSteps: 200,
  heartbeatMs: 30000,
  nodeTtlMs: 90000,
  address: '',
  httpPort: 0,
  apiKeyFile: '',
  maxContextChars: 6000,
};

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function int(value, fallback, min = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min ? Math.floor(parsed) : fallback;
}

function localHome() {
  return process.env.DSH_MESH_HOME || path.join(os.homedir(), '.dsh', 'mesh');
}

function bootLine(text) {
  try {
    const file = path.join(localHome(), 'mesh.log');
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, `${nowIso()} [${process.pid}] ${text}\n`);
  } catch {
    /* logging must never break the plugin */
  }
}

function defaultDshExe() {
  if (process.env.DSH_MESH_EXE) return process.env.DSH_MESH_EXE;
  const execPath = process.execPath || '';
  if (/\.exe$/i.test(execPath) && !/node\.exe$/i.test(execPath)) return execPath;
  return '';
}

function defaultDshCli() {
  if (process.env.DSH_MESH_CLI) return process.env.DSH_MESH_CLI;
  const resources = process.resourcesPath || '';
  if (resources) {
    const candidate = path.join(
      resources,
      'app.asar',
      'dsh',
      'node_modules',
      '@deepseek-ai',
      'dsh-desktop-host',
      'lib',
      'cli.js',
    );
    if (exists(candidate)) return candidate;
  }
  return '';
}

function normalizeSlots(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [cap, value] of Object.entries(raw)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) out[String(cap)] = Math.floor(parsed);
  }
  return out;
}

function resolveConfig(raw = {}) {
  const merged = { ...DEFAULTS, ...(raw || {}) };
  const root = String(merged.root || '').trim();
  const settings = {
    enabled: bool(merged.enabled, true),
    root,
    node: String(merged.node || os.hostname() || 'node').trim(),
    role: ['auto', 'coordinator', 'worker'].includes(merged.role) ? merged.role : 'auto',
    pollMs: int(merged.pollMs, 2000, 100),
    leaseMs: int(merged.leaseMs, 45000, 5000),
    leaseRenewMs: int(merged.leaseRenewMs, 10000, 1000),
    coordLeaseMs: int(merged.coordLeaseMs, 15000, 3000),
    maxConcurrent: int(merged.maxConcurrent, 2, 1),
    maxAttempts: int(merged.maxAttempts, 3, 1),
    stepTimeoutMs: int(merged.stepTimeoutMs, 900000, 10000),
    workerProfile: String(merged.workerProfile || 'mesh-worker'),
    dshExe: String(merged.dshExe || defaultDshExe()),
    dshCli: String(merged.dshCli || defaultDshCli()),
    peersFile: String(merged.peersFile || path.join(os.homedir(), '.dsh', 'lan-peers', 'peers.json')),
    caps: Array.isArray(merged.caps) && merged.caps.length ? merged.caps.map(String) : DEFAULT_CAPS,
    capSlots: normalizeSlots(merged.capSlots),
    maxQueuedSteps: int(merged.maxQueuedSteps, 200, 1),
    heartbeatMs: int(merged.heartbeatMs, 30000, 2000),
    nodeTtlMs: int(merged.nodeTtlMs, 90000, 5000),
    address: String(merged.address || ''),
    httpPort: int(merged.httpPort, 0, 0),
    apiKeyFile: String(merged.apiKeyFile || ''),
    maxContextChars: int(merged.maxContextChars, 6000, 500),
    home: localHome(),
  };
  settings.configured = Boolean(settings.enabled && settings.root);
  return settings;
}

function readApiKey(file) {
  if (!file) return null;
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (!text) return null;
    if (text.startsWith('{')) {
      const parsed = JSON.parse(text);
      return parsed.DEEPSEEK_API_KEY || parsed.apiKey || null;
    }
    const match = text.match(/DEEPSEEK_API_KEY\s*[:=]\s*(\S+)/);
    return match ? match[1] : text.split(/\r?\n/)[0].trim();
  } catch {
    return null;
  }
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function createRuntime(ctx, settings) {
  const paths = buildPaths(settings.root);
  const self = settings.node;
  const ledger = (event) => (detail = {}) => {
    try {
      appendJsonl(paths.ledgerFile(self), {
        ts: nowIso(),
        node: self,
        event,
        ...detail,
      });
    } catch (err) {
      bootLine(`ledger append failed: ${err.message}`);
    }
  };

  let stopped = false;
  let coordinator = false;
  let coordinatorTimer = null;
  let workerTimer = null;
  let heartbeatTimer = null;
  let activeSteps = 0;
  let backpressure = false;
  let lastQueue = { open: 0, running: 0, committed: 0 };
  const running = new Set();
  const runningBySelf = {};

  const ledgerDispatch = ledger('dispatch');
  const ledgerCommit = ledger('commit');
  const ledgerFail = ledger('fail');
  const ledgerLease = ledger('lease_expired');
  const ledgerTask = ledger('task');

  function peers() {
    const file = settings.peersFile;
    const state = readJson(file, null);
    const list = Array.isArray(state?.peers) ? state.peers : [];
    const online = new Map();
    for (const peer of list) {
      if (!peer?.online || !peer.address || !peer.httpPort) continue;
      const id = String(peer.name || peer.address);
      online.set(id, {
        node: id,
        address: peer.address,
        httpPort: peer.httpPort,
        caps: Array.isArray(peer.caps) && peer.caps.length ? peer.caps.map(String) : DEFAULT_CAPS,
      });
    }
    online.delete(self);
    return [...online.values()];
  }

  // Nodes come from the shared registry (capabilities + slots); lan-peers is
  // only a fallback for older deployments that do not write heartbeats.
  function knownNodes() {
    const registered = readNodes(paths, { ttlMs: settings.nodeTtlMs }).filter((entry) => entry.node !== self);
    return registered.length ? registered : peers();
  }

  function candidates(load) {
    return [
      {
        node: self,
        address: '127.0.0.1',
        httpPort: 0,
        caps: settings.caps,
        capSlots: settings.capSlots,
        load: load[self] || 0,
      },
      ...knownNodes().map((peer) => ({ ...peer, load: load[peer.node] || 0 })),
    ];
  }

  function loadMap(planStates) {
    const load = {};
    for (const state of planStates) {
      if (state.running && state.owner) load[state.owner] = (load[state.owner] || 0) + 1;
    }
    return load;
  }

  function reservationOf(state, now = Date.now()) {
    if (state.committed) return null;
    if (state.running && state.owner) return state.owner;
    if (!state.assignee) return null;
    const at = state.assignedAt ? Date.parse(state.assignedAt) : 0;
    // An assignment is a durable slot reservation; it goes stale with the lease.
    if (at && now - at > settings.leaseMs * 2) return null;
    return state.assignee;
  }

  function loadMapAcross(tasks) {
    const load = {};
    const now = Date.now();
    for (const task of tasks) {
      for (const state of task.states) {
        const node = reservationOf(state, now);
        if (node) load[node] = (load[node] || 0) + 1;
      }
    }
    return load;
  }

  function capUsageMap(tasks, extra = null) {
    const usage = {};
    const now = Date.now();
    for (const task of tasks) {
      for (const step of task.plan.steps) {
        const state = task.byId.get(step.id);
        const node = state ? reservationOf(state, now) : null;
        if (!node) continue;
        const nodeUsage = usage[node] || (usage[node] = {});
        for (const cap of step.caps) nodeUsage[cap] = (nodeUsage[cap] || 0) + 1;
      }
    }
    if (extra) {
      const nodeUsage = usage[extra.node] || (usage[extra.node] = {});
      for (const cap of extra.caps) nodeUsage[cap] = (nodeUsage[cap] || 0) + 1;
    }
    return usage;
  }

  function openStepCount(tasks) {
    let open = 0;
    for (const task of tasks) {
      for (const step of task.plan.steps) {
        const state = task.byId.get(step.id);
        if (state && !state.committed) open += 1;
      }
    }
    return open;
  }

  function taskList() {
    return listDirs(paths.tasksDir).map((taskId) => {
      const meta = readJson(paths.taskMeta(taskId), null);
      const plan = readJson(paths.plan(taskId), null);
      if (!meta || !plan) return null;
      const states = plan.steps.map((step) => stepState(paths, taskId, step));
      return { taskId, meta, plan, states, byId: new Map(states.map((state) => [state.id, state])) };
    }).filter(Boolean);
  }

  function finalizeTask(task) {
    if (task.meta.status === 'done') return;
    const result = {
      taskId: task.taskId,
      goal: task.meta.goal,
      status: 'done',
      total: task.plan.steps.length,
      committed: task.plan.steps.filter((step) => task.byId.get(step.id)?.commit).length,
      doneAt: nowIso(),
      steps: task.plan.steps.map((step) => {
        const commit = task.byId.get(step.id)?.commit || null;
        return { id: step.id, title: step.title, commit };
      }),
    };
    if (writeOnceJson(paths.taskResult(task.taskId), result)) {
      writeJsonAtomic(paths.taskMeta(task.taskId), { ...task.meta, status: 'done', doneAt: result.doneAt });
      ledgerTask({ task: task.taskId, detail: 'task done' });
      bootLine(`task done ${task.taskId}`);
    }
  }

  function reclaimExpiredLeases(task) {
    for (const step of task.plan.steps) {
      const leaseFile = paths.stepLease(task.taskId, step.id);
      const lease = readJson(leaseFile, null);
      if (!lease || leaseActive(lease)) continue;
      const state = readJson(paths.stepState(task.taskId, step.id), {}) || {};
      const attempts = Number(state.attempts || 0) + 1;
      writeJsonAtomic(paths.stepState(task.taskId, step.id), {
        ...state,
        attempts,
        lastNode: lease.owner || state.lastNode || null,
        lastError: 'lease expired (worker lost)',
        blocked: attempts >= settings.maxAttempts,
      });
      removeFile(leaseFile);
      ledgerLease({
        task: task.taskId,
        step: step.id,
        detail: `lease expired, owner=${lease.owner || 'unknown'}, attempts=${attempts}`,
      });
    }
  }

  function dispatch(task, pool, usage) {
    const ordered = task.plan.steps
      .filter((step) => {
        const state = task.byId.get(step.id);
        if (!state || state.committed || state.running || state.blocked) return false;
        return isReady(step, task.byId);
      })
      .sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50) || a.id.localeCompare(b.id));

    const known = new Set(pool.map((candidate) => candidate.node));
    for (const step of ordered) {
      const state = task.byId.get(step.id);
      const assignFile = paths.stepAssign(task.taskId, step.id);
      const current = readJson(assignFile, null);
      const stillValid = current?.node && known.has(current.node);
      if (stillValid && !(state.attempts > 0 && current.node === state.lastNode && known.size > 1)) continue;
      const pick = pickNode(pool, step, state, { usage });
      if (!pick) continue;
      writeJsonAtomic(assignFile, { node: pick.node, at: nowIso(), by: self, attempt: state.attempts });
      // Reserve the slot now so the next step in this same tick sees it.
      const nodeUsage = usage[pick.node] || (usage[pick.node] = {});
      for (const cap of step.caps) nodeUsage[cap] = (nodeUsage[cap] || 0) + 1;
      ledgerDispatch({
        task: task.taskId,
        step: step.id,
        detail: `assigned to ${pick.node} (load=${pick.load}, caps=${step.caps.join('+')}, priority=${step.priority ?? 50})`,
      });
    }
  }

  function coordTick() {
    if (stopped || !coordinator) return;
    try {
      // Pass 1: reclaim dead leases, finalize finished tasks, flag blocked ones.
      for (const task of taskList()) {
        if (task.meta.status === 'cancelled') continue;
        reclaimExpiredLeases(task);
      }
      let tasks = taskList();
      for (const task of tasks) {
        if (task.meta.status === 'cancelled') continue;
        if (task.byId.size && [...task.byId.values()].every((state) => state.committed)) {
          finalizeTask(task);
          continue;
        }
        if (task.meta.status === 'blocked') {
          const blocked = [...task.byId.values()].some((state) => state.blocked);
          if (blocked) continue;
          writeJsonAtomic(paths.taskMeta(task.taskId), { ...task.meta, status: 'active' });
        }
        if ([...task.byId.values()].some((state) => state.blocked)) {
          if (task.meta.status !== 'blocked') {
            writeJsonAtomic(paths.taskMeta(task.taskId), { ...task.meta, status: 'blocked', failedAt: nowIso() });
            ledgerTask({ task: task.taskId, detail: 'task blocked (step exhausted attempts)' });
            bootLine(`task blocked ${task.taskId}`);
          }
        }
      }

      // Pass 2: dispatch with slot accounting and backpressure.
      tasks = taskList();
      const open = openStepCount(tasks);
      const committed = tasks.reduce(
        (sum, task) => sum + [...task.byId.values()].filter((state) => state.committed).length,
        0,
      );
      lastQueue = { open, running: activeSteps, committed };
      backpressure = open > settings.maxQueuedSteps;
      if (backpressure) return;

      const pool = candidates(loadMapAcross(tasks));
      const usage = capUsageMap(tasks);
      for (const task of tasks) {
        if (task.meta.status === 'cancelled' || task.meta.status === 'done' || task.meta.status === 'blocked') continue;
        dispatch(task, pool, usage);
      }
    } catch (err) {
      bootLine(`coordinator tick failed: ${err.message}`);
    }
  }

  async function executeStep(task, step, state, attempt) {
    const stepDir = paths.stepDir(task.taskId, step.id);
    const attemptDir = paths.attemptDir(task.taskId, step.id, attempt);
    ensureDir(attemptDir);
    const inputsDir = path.join(attemptDir, 'inputs');
    ensureDir(inputsDir);

    let instruction = step.instruction;
    for (const dep of step.dependsOn) {
      const text = committedText(paths, task.taskId, dep, 400000);
      if (!text) continue;
      const depFile = path.join(inputsDir, `${dep}.md`);
      writeTextAtomic(depFile, text);
      const inline = text.length > settings.maxContextChars
        ? `${text.slice(0, settings.maxContextChars)}\n\n（完整内容见 inputs/${dep}.md，共 ${text.length} 字，请先读取该文件）`
        : text;
      instruction = instruction.replaceAll(`{{step:${dep}}}`, inline);
    }

    const leaseFile = paths.stepLease(task.taskId, step.id);
    const renew = setInterval(() => {
      try {
        renewLease(leaseFile, self, settings.leaseMs);
      } catch {
        /* ignore */
      }
    }, settings.leaseRenewMs);

    const apiKey = readApiKey(settings.apiKeyFile);
    const envExtra = apiKey ? { DEEPSEEK_API_KEY: apiKey } : {};
    const startedAt = nowIso();
    const res = await runStep({
      dshExe: settings.dshExe,
      dshCli: settings.dshCli,
      profile: settings.workerProfile,
      instruction,
      cwd: attemptDir,
      timeoutMs: settings.stepTimeoutMs,
      logPath: path.join(attemptDir, 'step.log'),
      envExtra,
      fake: process.env.DSH_MESH_FAKE === '1',
    });
    return { res, attemptDir, startedAt };
  }

  function commitStep(task, step, attemptDir, res, attempt) {
    const resultPath = path.join(attemptDir, 'result.md');
    writeTextAtomic(resultPath, res.text);
    const commit = {
      taskId: task.taskId,
      step: step.id,
      node: self,
      attempt,
      ts: nowIso(),
      bytes: Buffer.byteLength(res.text, 'utf8'),
      sha256: sha256(res.text),
      path: resultPath,
      elapsedMs: res.ms,
    };
    const won = writeOnceJson(paths.stepCommit(task.taskId, step.id), commit);
    if (won) {
      ledgerCommit({ task: task.taskId, step: step.id, detail: `committed ${commit.bytes}B` });
      bootLine(`step committed ${task.taskId}/${step.id}`);
    } else {
      ledgerCommit({ task: task.taskId, step: step.id, detail: 'duplicate commit ignored' });
    }
    return won;
  }

  function recordFailure(task, step, state, attempt, error, attemptDir) {
    const attempts = Math.max(attempt, Number(state.attempts || 0) + 1);
    const blocked = attempts >= settings.maxAttempts;
    writeJsonAtomic(paths.stepState(task.taskId, step.id), {
      attempts,
      lastNode: self,
      lastError: String(error?.message || error || 'unknown error').slice(0, 500),
      blocked,
      updatedAt: nowIso(),
    });
    try {
      writeJsonAtomic(path.join(attemptDir, 'error.json'), {
        at: nowIso(),
        node: self,
        attempt,
        message: String(error?.message || error || 'unknown error'),
        code: error?.code || null,
      });
    } catch {
      /* ignore */
    }
    ledgerFail({ task: task.taskId, step: step.id, detail: `${error?.message || error} (attempt ${attempt}/${settings.maxAttempts})` });
    removeFile(paths.stepAssign(task.taskId, step.id));
    bootLine(`step failed ${task.taskId}/${step.id} attempt=${attempt}: ${error?.message || error}`);
  }

  async function runAssigned(task, step) {
    const leaseFile = paths.stepLease(task.taskId, step.id);
    if (!tryTakeLease(leaseFile, self, settings.leaseMs)) return;
    if (exists(paths.stepCommit(task.taskId, step.id))) {
      releaseLease(leaseFile);
      return;
    }
    const state = readJson(paths.stepState(task.taskId, step.id), {}) || {};
    const attempt = Number(state.attempts || 0) + 1;
    activeSteps += 1;
    running.add(`${task.taskId}/${step.id}`);
    for (const cap of step.caps) runningBySelf[cap] = (runningBySelf[cap] || 0) + 1;
    try {
      const { res, attemptDir } = await executeStep(task, step, state, attempt);
      if (!res.text || !res.text.trim()) throw new Error('empty result from agent turn');
      commitStep(task, step, attemptDir, res, attempt);
    } catch (err) {
      const attemptDir = paths.attemptDir(task.taskId, step.id, attempt);
      recordFailure(task, step, state, attempt, err, attemptDir);
    } finally {
      releaseLease(leaseFile);
      activeSteps -= 1;
      running.delete(`${task.taskId}/${step.id}`);
      for (const cap of step.caps) {
        runningBySelf[cap] = Math.max(0, (runningBySelf[cap] || 0) - 1);
      }
    }
  }

  // Local slot gate: the shared registry may hand us more steps than our own
  // per-capacity budget allows, so the worker refuses steps beyond capSlots.
  function selfHasFreeSlot(step) {
    for (const cap of step.caps) {
      const limit = settings.capSlots[cap];
      if (!limit) continue;
      if ((runningBySelf[cap] || 0) >= limit) return false;
    }
    return true;
  }

  function workerTick() {
    if (stopped || activeSteps >= settings.maxConcurrent) return;
    try {
      for (const task of taskList()) {
        if (task.meta.status === 'cancelled' || task.meta.status === 'done') continue;
        for (const step of task.plan.steps) {
          if (activeSteps >= settings.maxConcurrent) return;
          const assign = readJson(paths.stepAssign(task.taskId, step.id), null);
          if (!assign || assign.node !== self) continue;
          if (exists(paths.stepCommit(task.taskId, step.id))) continue;
          const lease = readJson(paths.stepLease(task.taskId, step.id), null);
          if (leaseActive(lease) && lease.owner !== self) continue;
          const key = `${task.taskId}/${step.id}`;
          if (running.has(key)) continue;
          if (!selfHasFreeSlot(step)) continue;
          void runAssigned(task, step);
        }
      }
    } catch (err) {
      bootLine(`worker tick failed: ${err.message}`);
    }
  }

  function releaseOwnOrphanLeases() {
    for (const taskId of listDirs(paths.tasksDir)) {
      const plan = readJson(paths.plan(taskId), null);
      if (!plan?.steps) continue;
      for (const step of plan.steps) {
        const leaseFile = paths.stepLease(taskId, step.id);
        const lease = readJson(leaseFile, null);
        if (lease && lease.owner === self) {
          removeFile(leaseFile);
          ledgerLease({ task: taskId, step: step.id, detail: 'released orphan lease on startup' });
        }
      }
    }
  }

  function coordinatorAttempt() {
    if (settings.role === 'worker') return;
    try {
      if (coordinator) {
        coordinator = renewLease(paths.coordLease, self, settings.coordLeaseMs);
        if (!coordinator) bootLine('lost coordinator lease');
        return;
      }
      coordinator = tryTakeLease(paths.coordLease, self, settings.coordLeaseMs);
      if (coordinator) {
        bootLine(`coordinator acquired by ${self}`);
        ledgerTask({ detail: `coordinator acquired by ${self}` });
      }
    } catch (err) {
      bootLine(`coordinator attempt failed: ${err.message}`);
    }
  }

  function poll() {
    if (stopped) return;
    coordinatorAttempt();
    if (settings.role !== 'coordinator') workerTick();
    if (coordinator) coordTick();
  }

  function snapshot() {
    const tasks = taskList().map((task) => ({
      ...taskSummary(task.meta, task.plan, task.byId),
      steps: task.plan.steps.map((step) => task.byId.get(step.id)),
    }));
    const counts = tasks.reduce((acc, task) => {
      acc[task.status] = (acc[task.status] || 0) + 1;
      return acc;
    }, {});
    return {
      node: self,
      root: settings.root,
      role: settings.role,
      coordinator: coordinator ? self : readJson(paths.coordLease, null)?.owner || null,
      coordinatorExpiry: readJson(paths.coordLease, null)?.expiry || null,
      peers: peers().map((peer) => ({ node: peer.node, address: peer.address, httpPort: peer.httpPort })),
      nodes: knownNodes().map((peer) => ({
        node: peer.node,
        address: peer.address,
        httpPort: peer.httpPort,
        caps: peer.caps,
        capSlots: peer.capSlots,
        maxConcurrent: peer.maxConcurrent,
        ageMs: peer.ageMs,
      })),
      capSlots: settings.capSlots,
      runningBySelf: { ...runningBySelf },
      queue: lastQueue,
      backpressure,
      maxQueuedSteps: settings.maxQueuedSteps,
      activeSteps,
      running: [...running],
      tasks: counts,
      workerProfile: settings.workerProfile,
      dshExe: settings.dshExe,
      dshCli: settings.dshCli,
      caps: settings.caps,
      updatedAt: nowIso(),
    };
  }

  function submit({ goal, steps, createdBy }) {
    const plan = normalizePlan(steps);
    const taskId = `t-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    ensureDir(paths.taskDir(taskId));
    writeJsonAtomic(paths.plan(taskId), plan);
    writeJsonAtomic(paths.taskMeta(taskId), {
      id: taskId,
      goal: String(goal || steps?.[0]?.instruction || '').slice(0, 2000),
      createdAt: nowIso(),
      createdBy: createdBy || self,
      status: 'active',
    });
    ledgerTask({ task: taskId, detail: `submitted ${plan.steps.length} step(s): ${goal}`.slice(0, 300) });
    bootLine(`task submitted ${taskId} steps=${plan.steps.length}`);
    return { taskId, steps: plan.steps.map((step) => ({ id: step.id, title: step.title, dependsOn: step.dependsOn })) };
  }

  function cancel(taskId) {
    const meta = readJson(paths.taskMeta(taskId), null);
    if (!meta) return false;
    writeJsonAtomic(paths.taskMeta(taskId), { ...meta, status: 'cancelled', cancelledAt: nowIso() });
    ledgerTask({ task: taskId, detail: 'cancelled' });
    return true;
  }

  function taskDetail(taskId) {
    const task = taskList().find((entry) => entry.taskId === taskId);
    if (!task) return null;
    return {
      ...taskSummary(task.meta, task.plan, task.byId),
      node: self,
      steps: task.plan.steps.map((step) => {
        const state = task.byId.get(step.id);
        return {
          id: step.id,
          title: step.title,
          state: state.committed ? 'committed' : state.blocked ? 'blocked' : state.running ? 'running' : state.assignee ? 'assigned' : 'waiting',
          assignee: state.assignee,
          attempts: state.attempts,
          lastError: state.lastError,
          bytes: state.commit?.bytes || 0,
          resultPath: state.commit?.path || null,
        };
      }),
    };
  }

  function heartbeat() {
    try {
      writeHeartbeat(paths, {
        node: self,
        address: settings.address,
        httpPort: settings.httpPort,
        caps: settings.caps,
        capSlots: settings.capSlots,
        maxConcurrent: settings.maxConcurrent,
        role: settings.role,
        coordinator,
        activeSteps,
        pid: process.pid,
      });
    } catch (err) {
      bootLine(`heartbeat failed: ${err.message}`);
    }
  }

  function start() {
    if (!settings.configured) {
      bootLine(`mesh disabled: missing root (enabled=${settings.enabled})`);
      return;
    }
    try {
      ensureDir(paths.tasksDir);
      ensureDir(paths.coordDir);
      ensureDir(paths.ledgerDir(self));
      ensureDir(paths.nodesDir);
    } catch (err) {
      bootLine(`mesh cannot use root ${settings.root}: ${err.message}`);
      return;
    }
    releaseOwnOrphanLeases();
    heartbeat();
    coordinatorTimer = setInterval(coordinatorAttempt, settings.coordLeaseMs / 2);
    workerTimer = setInterval(poll, settings.pollMs);
    heartbeatTimer = setInterval(heartbeat, settings.heartbeatMs);
    bootLine(
      `mesh started node=${self} role=${settings.role} root=${settings.root} profile=${settings.workerProfile} exe=${settings.dshExe || 'MISSING'} cli=${settings.dshCli || 'MISSING'} concurrency=${settings.maxConcurrent} caps=${settings.caps.join('+')} slots=${JSON.stringify(settings.capSlots)}`,
    );
    if (coordinatorTimer.unref) coordinatorTimer.unref();
    if (workerTimer.unref) workerTimer.unref();
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }

  function stop() {
    stopped = true;
    clearInterval(coordinatorTimer);
    clearInterval(workerTimer);
    clearInterval(heartbeatTimer);
    if (coordinator) {
      const lease = readJson(paths.coordLease, null);
      if (lease?.owner === self) removeFile(paths.coordLease);
      coordinator = false;
    }
    removeFile(paths.nodeFile(self));
    bootLine('mesh stopped');
  }

  return {
    start,
    stop,
    heartbeat,
    snapshot,
    submit,
    cancel,
    taskDetail,
    settings,
    paths,
    executor: { runStep, withTimeout },
  };
}

const VALUE_SCHEMA = { type: 'object', additionalProperties: true };

function renderToolValue(_args, value) {
  const text = typeof value?.message === 'string' ? value.message : JSON.stringify(value, null, 2);
  return [{ type: 'text', text }];
}

function defineMeshTools(runtime) {
  const settings = runtime.settings;
  return [
    {
      name: 'mesh_submit',
      description:
        'Submit a durable multi-step task to the LAN mesh. Steps run on whichever node has spare capacity; committed steps never re-run, and a crashed worker\'s step is re-dispatched elsewhere.',
      parameters: {
        goal: { type: 'string', description: 'One-line goal of the whole task.' },
        steps: {
          type: 'array',
          description:
            'Steps of the plan. Each item: { id, title, instruction, dependsOn?, caps?, serial? }. Use {{step:ID}} inside an instruction to inline an earlier step\'s committed result.',
          items: { type: 'object', additionalProperties: true },
        },
      },
      output: { schema: VALUE_SCHEMA, render: renderToolValue },
      async execute(args) {
        const created = runtime.submit({
          goal: args.goal,
          steps: args.steps,
          createdBy: settings.node,
        });
        return {
          ok: true,
          message: `任务 ${created.taskId} 已提交，共 ${created.steps.length} 步：\n${created.steps
            .map((step) => `- ${step.id} ${step.title}${step.dependsOn.length ? ` (依赖 ${step.dependsOn.join(',')})` : ''}`)
            .join('\n')}\n用 mesh_tasks 查看进度。`,
          ...created,
        };
      },
    },
    {
      name: 'mesh_tasks',
      description: 'List mesh tasks with per-step state, assignee and attempts (shared-folder ledger, works from any node).',
      parameters: {
        taskId: { type: 'string', description: 'Optional: return detail for a single task.' },
        limit: { type: 'number', description: 'Max tasks to list (default 10).' },
      },
      output: { schema: VALUE_SCHEMA, render: renderToolValue },
      async execute(args) {
        if (args.taskId) {
          const detail = runtime.taskDetail(String(args.taskId));
          if (!detail) return { ok: false, message: `找不到任务 ${args.taskId}` };
          return {
            ok: true,
            message: `任务 ${detail.id} [${detail.status}] ${detail.goal}\n${detail.steps
              .map((step) => `- ${step.id} ${step.title}: ${step.state}${step.assignee ? ` @${step.assignee}` : ''} attempts=${step.attempts}${step.lastError ? ` err=${step.lastError}` : ''}`)
              .join('\n')}`,
            task: detail,
          };
        }
        const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
        const snap = runtime.snapshot();
        const tasks = snap.tasks;
        const rows = snapshotTaskRows(runtime, limit);
        return {
          ok: true,
          message: rows.length
            ? `共 ${tasks.done || 0} 完成 / ${tasks.running || 0} 运行中 / ${tasks.pending || 0} 待跑 / ${tasks.blocked || 0} 阻塞\n${rows
                .map((row) => `- ${row.id} [${row.status}] ${row.committed}/${row.steps} 步 ${row.goal}`)
                .join('\n')}`
            : '还没有任务。用 mesh_submit 提交。',
          tasks: rows,
        };
      },
    },
    {
      name: 'mesh_plan',
      description: `Build a multi-step plan from a built-in template (${TEMPLATE_NAMES.join(', ')}) and optionally submit it. Templates encode the split/parallel/merge pattern for a kind of work, so the plan does not have to be written by hand.`,
      parameters: {
        template: { type: 'string', description: `Template name: ${TEMPLATE_NAMES.join(', ')}.`, enum: TEMPLATE_NAMES },
        goal: { type: 'string', description: 'One-line goal used as the task title.' },
        args: {
          type: 'object',
          additionalProperties: true,
          description:
            'Template arguments, e.g. { target, sections, material, words, episodes, stack }. Passed through to the template builder.',
        },
        submit: { type: 'boolean', description: 'Submit immediately. Default false: return the preview only.' },
      },
      output: { schema: VALUE_SCHEMA, render: renderToolValue },
      async execute(args) {
        const template = String(args.template || '').trim();
        // Template knobs may be nested under `args` or passed flat (count, sections, ...).
        const knobs = { ...(args.args && typeof args.args === 'object' ? args.args : {}) };
        for (const [key, value] of Object.entries(args)) {
          if (['template', 'goal', 'submit', 'args'].includes(key)) continue;
          if (value !== undefined && value !== null) knobs[key] = value;
        }
        let built;
        try {
          built = buildTemplate(template, knobs);
        } catch (err) {
          return { ok: false, message: `模板 ${template || '(空)'} 不可用：${err.message}` };
        }
        const goal = String(args.goal || knobs.target || `${built.template} 任务`);
        const planned = { template: built.template, goal, steps: plannedSteps(built.steps) };
        const preview = built.steps.map((step) => {
          const caps = step.caps?.join('+') || 'text';
          const deps = step.dependsOn?.length ? ` ← ${step.dependsOn.join(',')}` : '';
          return `- ${step.id} ${step.title}${deps} [${caps}]${step.serial ? ' serial' : ''}`;
        });
        if (!args.submit) {
          return {
            ok: true,
            message: `模板 ${built.template} 预览：${built.steps.length} 步（未提交）\n${preview.join('\n')}\n确认后加 submit=true 提交。`,
            template: built.template,
            goal,
            plan: planned,
            steps: planned.steps,
          };
        }
        const created = runtime.submit({ goal, steps: built.steps, createdBy: settings.node });
        return {
          ok: true,
          message: `任务 ${created.taskId} 已按模板 ${built.template} 提交：${created.steps.length} 步\n${preview.join('\n')}\n用 mesh_tasks 查看进度。`,
          plan: planned,
          ...created,
        };
      },
    },
    {
      name: 'mesh_status',
      description:
        'Show mesh cluster status: coordinator owner, live nodes with capabilities and slot usage, queue depth, backpressure and per-capacity occupancy of this node.',
      parameters: {},
      output: { schema: VALUE_SCHEMA, render: renderToolValue },
      async execute() {
        const snap = runtime.snapshot();
        const nodeLine = (entry) => {
          const caps = entry.caps?.length ? entry.caps.join('+') : 'text';
          const slots = entry.capSlots && Object.keys(entry.capSlots).length ? JSON.stringify(entry.capSlots) : '-';
          const age = Number.isFinite(entry.ageMs) ? `${Math.round(entry.ageMs / 1000)}s` : 'self';
          return `- ${entry.node} ${entry.address || ''}${entry.httpPort ? `:${entry.httpPort}` : ''} caps=${caps} slots=${slots} age=${age}`;
        };
        const slots = Object.keys(snap.capSlots || {}).length
          ? Object.entries(snap.capSlots).map(([cap, limit]) => `${cap}=${snap.runningBySelf?.[cap] || 0}/${limit}`).join(' ')
          : `-/${settings.maxConcurrent}`;
        return {
          ok: true,
          message: [
            `节点 ${snap.node}（${snap.role}）`,
            `协调器：${snap.coordinator || '未选出'}`,
            `存活节点：\n${snap.nodes?.length ? snap.nodes.map(nodeLine).join('\n') : '- 无（只有本机）'}`,
            `本机执行中：${snap.activeSteps}/${settings.maxConcurrent}，按通道：${slots}`,
            `队列：待跑 ${snap.queue?.open ?? 0} / 已提交 ${snap.queue?.committed ?? 0}${snap.backpressure ? ` [背压开启，上限 ${snap.maxQueuedSteps}]` : ''}`,
            `任务：完成 ${snap.tasks.done || 0} / 运行 ${snap.tasks.running || 0} / 待跑 ${snap.tasks.pending || 0} / 阻塞 ${snap.tasks.blocked || 0}`,
            `共享盘：${snap.root}`,
          ].join('\n'),
          status: snap,
        };
      },
    },
    {
      name: 'mesh_cancel',
      description: 'Cancel a mesh task (running steps finish, nothing new is dispatched).',
      parameters: { taskId: { type: 'string', description: 'Task id to cancel.' } },
      output: { schema: VALUE_SCHEMA, render: renderToolValue },
      async execute(args) {
        const ok = runtime.cancel(String(args.taskId || ''));
        return { ok, message: ok ? `任务 ${args.taskId} 已取消` : `找不到任务 ${args.taskId}` };
      },
    },
  ];
}

function plannedSteps(steps) {
  return steps.map((step) => ({
    id: step.id,
    title: step.title,
    dependsOn: step.dependsOn || [],
    caps: step.caps || ['text'],
    serial: Boolean(step.serial),
    priority: step.priority ?? 50,
  }));
}

function snapshotTaskRows(runtime, limit) {
  const root = runtime.settings.root;
  const paths = buildPaths(root);
  const rows = [];
  for (const taskId of listDirs(paths.tasksDir)) {
    const meta = readJson(paths.taskMeta(taskId), null);
    const plan = readJson(paths.plan(taskId), null);
    if (!meta || !plan) continue;
    const states = plan.steps.map((step) => stepState(paths, taskId, step));
    rows.push(taskSummary(meta, plan, new Map(states.map((state) => [state.id, state]))));
  }
  return rows
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

function attachTools(ctx, runtime) {
  const state = { done: false, attempts: 0 };
  const tryRegister = () => {
    if (state.done) return true;
    let tools;
    try {
      tools = ctx?.tools;
    } catch {
      return false;
    }
    if (!tools || typeof tools.register !== 'function') return false;
    const existing = typeof tools.list === 'function' ? new Set(tools.list().map((tool) => tool.name)) : new Set();
    for (const definition of defineMeshTools(runtime)) {
      if (existing.has(definition.name)) continue;
      try {
        tools.register(definition);
      } catch (err) {
        if (/already/i.test(err.message)) continue;
        bootLine(`tool registration failed for ${definition.name}: ${err.message}`);
      }
    }
    state.done = true;
    bootLine('mesh tools registered: mesh_plan, mesh_submit, mesh_tasks, mesh_status, mesh_cancel');
    return true;
  };

  if (tryRegister()) return;
  try {
    ctx.inject(['tools'], () => {
      tryRegister();
    });
  } catch (err) {
    bootLine(`ctx.inject unavailable: ${err.message}`);
  }
  const timer = setInterval(() => {
    state.attempts += 1;
    if (tryRegister() || state.attempts >= 15) clearInterval(timer);
  }, 1000);
}

export function apply(ctx, config = {}) {
  const settings = resolveConfig(config);
  const runtime = createRuntime(ctx, settings);
  bootLine(
    `apply: configured=${settings.configured} root=${settings.root || '-'} node=${settings.node} tools=${(() => {
      try {
        return Boolean(ctx?.tools);
      } catch {
        return 'blocked';
      }
    })()} inject=${typeof ctx?.inject}`,
  );
  runtime.start();
  attachTools(ctx, runtime);

  const dispose = () => runtime.stop();
  try {
    ctx.effect(() => dispose);
  } catch {
    try {
      ctx.on('dispose', dispose);
    } catch {
      /* last resort: leave timers running; they are unref'd */
    }
  }
  return runtime;
}

export default { name, apply };
