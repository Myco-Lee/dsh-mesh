// dsh-mesh: plan normalization, DAG checks, step state, load-aware selection.

import { readFileSync } from 'node:fs';
import { readJson, exists, safeId } from './store.js';

export const DEFAULT_CAPS = ['text'];

export function normalizePlan(input) {
  const raw = Array.isArray(input) ? input : input?.steps;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('plan needs at least one step');
  }
  const steps = raw.map((step, index) => {
    const id = safeId(step.id || `s${index + 1}`);
    const instruction = String(step.instruction || step.prompt || '').trim();
    if (!instruction) throw new Error(`step ${id} has no instruction`);
    const dependsOn = Array.isArray(step.dependsOn)
      ? step.dependsOn.map((dep) => safeId(dep))
      : Array.isArray(step.after)
        ? step.after.map((dep) => safeId(dep))
        : [];
    const caps = Array.isArray(step.caps) && step.caps.length
      ? step.caps.map((cap) => String(cap))
      : DEFAULT_CAPS;
    return {
      id,
      title: String(step.title || id),
      instruction,
      dependsOn: Array.from(new Set(dependsOn)).filter((dep) => dep !== id),
      caps,
      priority: Number.isFinite(Number(step.priority)) ? Number(step.priority) : 50,
      serial: Boolean(step.serial),
    };
  });

  const ids = new Set();
  for (const step of steps) {
    if (ids.has(step.id)) throw new Error(`duplicate step id: ${step.id}`);
    ids.add(step.id);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!ids.has(dep)) throw new Error(`step ${step.id} depends on unknown step ${dep}`);
    }
  }
  assertAcyclic(steps);
  return { version: 1, steps };
}

function assertAcyclic(steps) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const state = new Map(); // 0 unvisited, 1 visiting, 2 done
  const visit = (id, trail) => {
    const mark = state.get(id) || 0;
    if (mark === 2) return;
    if (mark === 1) throw new Error(`dependency cycle: ${[...trail, id].join(' -> ')}`);
    state.set(id, 1);
    for (const dep of byId.get(id)?.dependsOn || []) visit(dep, [...trail, id]);
    state.set(id, 2);
  };
  for (const step of steps) visit(step.id, []);
}

// Resolve committed result text for a step (used for {{step:ID}} expansion).
export function committedText(paths, taskId, stepId, maxChars = 20000) {
  const commit = readJson(paths.stepCommit(taskId, stepId), null);
  if (!commit?.path) return null;
  try {
    const text = readFileSync(commit.path, 'utf8');
    return text.length > maxChars
      ? `${text.slice(0, maxChars)}\n\n[truncated ${text.length - maxChars} chars]`
      : text;
  } catch {
    return null;
  }
}

export function stepState(paths, taskId, step) {
  const stateFile = paths.stepState(taskId, step.id);
  const commitFile = paths.stepCommit(taskId, step.id);
  const leaseFile = paths.stepLease(taskId, step.id);
  const assignFile = paths.stepAssign(taskId, step.id);
  const state = readJson(stateFile, {}) || {};
  const assign = readJson(assignFile, null);
  const lease = readJson(leaseFile, null);
  const committed = exists(commitFile);
  const running = Boolean(lease && Number(lease.expiry) > Date.now());
  const failed = Boolean(state.blocked);
  return {
    id: step.id,
    title: step.title,
    caps: step.caps,
    dependsOn: step.dependsOn,
    priority: step.priority,
    serial: step.serial,
    attempts: Number(state.attempts || 0),
    lastNode: state.lastNode || null,
    lastError: state.lastError || null,
    blocked: failed,
    committed,
    running,
    owner: running ? lease.owner : null,
    assignee: assign?.node || null,
    assignedAt: assign?.at || null,
    commit: committed ? readJson(commitFile, null) : null,
  };
}

export function isReady(step, stepStates) {
  if (stepStates.get(step.id)?.committed) return false;
  return step.dependsOn.every((dep) => stepStates.get(dep)?.committed);
}

// candidates: [{ node, load, caps, capSlots?, address }]
// usage: { node: { cap: runningCount } }
// Routing: capability match -> slot availability -> avoid the node that just
// failed (anti-affinity) -> least loaded.
export function slotLimit(candidate, cap) {
  const raw = candidate?.capSlots?.[cap];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
}

export function hasFreeSlot(candidate, step, usage) {
  const used = usage?.[candidate.node] || {};
  return step.caps.every((cap) => Number(used[cap] || 0) < slotLimit(candidate, cap));
}

export function pickNode(candidates, step, state, { exclude = [], usage = {} } = {}) {
  const capable = candidates.filter((candidate) =>
    step.caps.every((cap) => (candidate.caps || DEFAULT_CAPS).includes(cap)),
  );
  const pool = capable.length ? capable : candidates;
  const withSlot = pool.filter((candidate) => hasFreeSlot(candidate, step, usage));
  if (!withSlot.length) return null;
  const avoid = new Set([...(state?.lastNode ? [state.lastNode] : []), ...exclude]);
  const preferred = withSlot.filter((candidate) => !avoid.has(candidate.node));
  const usable = preferred.length ? preferred : withSlot;
  return usable
    .slice()
    .sort((a, b) => a.load - b.load || String(a.node).localeCompare(String(b.node)))[0];
}

export function taskSummary(taskMeta, plan, states) {
  const steps = plan.steps.map((step) => states.get(step.id));
  const committed = steps.filter((step) => step.committed).length;
  const running = steps.filter((step) => step.running).length;
  const blocked = steps.filter((step) => step.blocked).length;
  const status = committed === steps.length
    ? 'done'
    : blocked > 0
      ? 'blocked'
      : running > 0
        ? 'running'
        : 'pending';
  return {
    id: taskMeta.id,
    goal: taskMeta.goal,
    status,
    steps: steps.length,
    committed,
    running,
    blocked,
    createdAt: taskMeta.createdAt,
    createdBy: taskMeta.createdBy,
  };
}
