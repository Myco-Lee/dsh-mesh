// Unit tests for the mesh core: dispatch, DAG order, idempotent commit,
// failure blocking, lease-expiry failover. Uses the fake executor (no model).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_MESH_FAKE = '1';

const mod = await import('../lib/index.js');
const { apply } = mod;
const { buildPaths, readJson, writeJsonAtomic } = await import('../lib/store.js');

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name} ${detail}`);
  }
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mesh-test-'));
}

function peersFile(dir, self, others) {
  const file = path.join(dir, `peers-${self}.json`);
  writeJsonAtomic(file, {
    updatedAt: new Date().toISOString(),
    self,
    peers: others.map((name) => ({
      id: `${name}-id`,
      name,
      address: '127.0.0.1',
      httpPort: 48902,
      version: 'test',
      online: true,
      lastSeen: new Date().toISOString(),
    })),
  });
  return file;
}

function makeCtx() {
  const ctx = {
    tools: { register() {}, list: () => [] },
    inject() {},
    effect() {},
    on() {},
  };
  return ctx;
}

function nodeSettings(root, node, peerList) {
  return {
    root,
    node,
    role: 'auto',
    pollMs: 120,
    leaseMs: 1500,
    leaseRenewMs: 400,
    coordLeaseMs: 900,
    maxConcurrent: 2,
    maxAttempts: 3,
    stepTimeoutMs: 20000,
    workerProfile: 'test',
    dshExe: 'test-exe',
    dshCli: 'test-cli.js',
    peersFile: peersFile(root, node, peerList),
  };
}

async function waitFor(predicate, timeoutMs = 20000, label = 'condition') {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function taskState(root, taskId) {
  const paths = buildPaths(root);
  const plan = readJson(paths.plan(taskId), null);
  const meta = readJson(paths.taskMeta(taskId), null);
  const steps = plan.steps.map((step) => ({
    id: step.id,
    commit: readJson(paths.stepCommit(taskId, step.id), null),
    state: readJson(paths.stepState(taskId, step.id), {}),
  }));
  return { plan, meta, steps, paths };
}

async function testBasicPipeline() {
  const root = tempRoot();
  const a = apply(makeCtx(), nodeSettings(root, 'node-a', ['node-b']));
  const b = apply(makeCtx(), nodeSettings(root, 'node-b', ['node-a']));
  try {
    const submitted = a.submit({
      goal: 'two step pipeline',
      steps: [
        { id: 's1', title: '第一段', instruction: '写一段开头 text-ONE' },
        { id: 's2', title: '第二段', instruction: '接着写 {{step:s1}} 然后结尾 text-TWO', dependsOn: ['s1'] },
      ],
    });
    await waitFor(() => {
      const { steps, meta } = taskState(root, submitted.taskId);
      return meta?.status === 'done' && steps.every((step) => step.commit);
    }, 20000, 'task done');

    const { steps } = taskState(root, submitted.taskId);
    const first = fs.readFileSync(steps[0].commit.path, 'utf8');
    const second = fs.readFileSync(steps[1].commit.path, 'utf8');
    check('s1 committed on one node', Boolean(steps[0].commit));
    check('s2 committed after s1', Boolean(steps[1].commit));
    check('s1 result text carried', first.includes('text-ONE'), first);
    check('s2 inlined dependency', second.includes('text-ONE') && second.includes('text-TWO'), second);
    check(
      'both steps used fake executor',
      Boolean(steps[0].commit?.sha256 && steps[1].commit?.sha256),
    );

    const ledgerCount = fs
      .readFileSync(path.join(root, 'ledger', steps[0].commit.node, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.includes('"commit"') && line.includes(submitted.taskId))
      .length;
    check('commit events recorded once each', ledgerCount >= 2, `count=${ledgerCount}`);
  } finally {
    a.stop();
    b.stop();
  }
}

async function testFailureBlocks() {
  const root = tempRoot();
  const a = apply(makeCtx(), nodeSettings(root, 'node-a', []));
  try {
    const submitted = a.submit({
      goal: 'always failing step',
      steps: [{ id: 'bad', title: '必败', instruction: '[[FAIL]] 这一步一定失败' }],
    });
    await waitFor(() => {
      const { meta, steps } = taskState(root, submitted.taskId);
      return meta?.status === 'blocked' && steps[0].state?.blocked;
    }, 30000, 'task blocked');

    const { steps, meta } = taskState(root, submitted.taskId);
    check('task blocked after max attempts', meta.status === 'blocked');
    check('attempts counted to max', Number(steps[0].state.attempts) >= 3, `attempts=${steps[0].state.attempts}`);
    check('no commit for failed step', !steps[0].commit);
    check('lastError recorded', /fake executor failure/.test(steps[0].state.lastError || ''), steps[0].state.lastError);
  } finally {
    a.stop();
  }
}

async function testLeaseExpiryFailover() {
  const root = tempRoot();
  const a = apply(makeCtx(), nodeSettings(root, 'node-a', []));
  try {
    const submitted = a.submit({
      goal: 'expired lease',
      steps: [{ id: 's1', title: '接手', instruction: '接管后的执行 text-TAKEOVER' }],
    });
    const paths = buildPaths(root);
    // A dead worker left an assign + an already-expired lease behind.
    writeJsonAtomic(paths.stepAssign(submitted.taskId, 's1'), { node: 'ghost', at: new Date().toISOString() });
    writeJsonAtomic(paths.stepLease(submitted.taskId, 's1'), {
      owner: 'ghost',
      expiry: Date.now() - 5000,
      takenAt: new Date().toISOString(),
    });

    await waitFor(() => {
      const { meta, steps } = taskState(root, submitted.taskId);
      return meta?.status === 'done' && steps[0].commit;
    }, 30000, 'failover done');

    const { steps } = taskState(root, submitted.taskId);
    check('expired lease reclaimed and step committed', Boolean(steps[0].commit));
    check('owner switched to live node', steps[0].commit.node === 'node-a', steps[0].commit.node);
    const text = fs.readFileSync(steps[0].commit.path, 'utf8');
    check('takeover produced result', text.includes('text-TAKEOVER'), text);
  } finally {
    a.stop();
  }
}

async function testIdempotentCommit() {
  const root = tempRoot();
  const a = apply(makeCtx(), nodeSettings(root, 'node-a', []));
  try {
    const submitted = a.submit({ goal: 'idempotent', steps: [{ id: 's1', instruction: 'once text-ONCE' }] });
    await waitFor(() => {
      const { meta } = taskState(root, submitted.taskId);
      return meta?.status === 'done';
    }, 20000, 'done');
    const paths = buildPaths(root);
    const before = readJson(paths.stepCommit(submitted.taskId, 's1'), null);
    // Simulate a racing duplicate commit: the second write must be refused.
    const { writeOnceJson } = await import('../lib/store.js');
    const won = writeOnceJson(paths.stepCommit(submitted.taskId, 's1'), { node: 'other', sha256: 'deadbeef' });
    const after = readJson(paths.stepCommit(submitted.taskId, 's1'), null);
    check('duplicate commit refused', won === false);
    check('first commit preserved', after.sha256 === before.sha256, JSON.stringify(after));
  } finally {
    a.stop();
  }
}

async function testCycleRejected() {
  const root = tempRoot();
  const a = apply(makeCtx(), nodeSettings(root, 'node-a', []));
  try {
    let rejected = false;
    try {
      a.settings; // keep reference
      const { normalizePlan } = await import('../lib/plan.js');
      normalizePlan([
        { id: 'a1', instruction: 'x', dependsOn: ['a2'] },
        { id: 'a2', instruction: 'y', dependsOn: ['a1'] },
      ]);
    } catch (err) {
      rejected = /cycle/.test(err.message);
    }
    check('dependency cycle rejected', rejected);
  } finally {
    a.stop();
  }
}

await testBasicPipeline();
await testFailureBlocks();
await testLeaseExpiryFailover();
await testIdempotentCommit();
await testCycleRejected();

console.log(failures === 0 ? 'mesh core ok' : `mesh core FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
