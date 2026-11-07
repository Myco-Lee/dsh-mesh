// M3 tests: plan templates, capability routing, per-cap slots, priority order,
// backpressure. Uses the fake executor (no model, no network).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DSH_MESH_FAKE = '1';

const { apply } = await import('../lib/index.js');
const { buildTemplate, TEMPLATE_NAMES } = await import('../lib/templates.js');
const { normalizePlan } = await import('../lib/plan.js');
const { buildPaths, readJson, writeJsonAtomic } = await import('../lib/store.js');
const { writeHeartbeat } = await import('../lib/registry.js');

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mesh-m3-'));
}

function makeCtx(sink = []) {
  return {
    tools: {
      register(definition) {
        sink.push(definition);
      },
      list: () => sink,
    },
    inject() {},
    effect() {},
    on() {},
  };
}

function settingsFor(root, node, extra = {}) {
  return {
    root,
    node,
    role: 'coordinator',
    pollMs: 120,
    leaseMs: 1500,
    leaseRenewMs: 400,
    coordLeaseMs: 900,
    maxConcurrent: 4,
    maxAttempts: 3,
    stepTimeoutMs: 20000,
    workerProfile: 'test',
    dshExe: 'test-exe',
    dshCli: 'test-cli.js',
    peersFile: path.join(root, `no-peers-${node}.json`),
    ...extra,
  };
}

async function waitFor(predicate, timeoutMs = 15000, label = 'condition') {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function testTemplates() {
  for (const name of TEMPLATE_NAMES) {
    const built = buildTemplate(name, { goal: '写一个东西', count: 3 });
    const plan = normalizePlan(built.steps);
    check(`template ${name} normalizes`, plan.steps.length === built.steps.length, `${plan.steps.length}`);
    check(`template ${name} has wiring`, plan.steps.some((step) => step.dependsOn.length > 0));
    check(
      `template ${name} ids unique`,
      new Set(plan.steps.map((step) => step.id)).size === plan.steps.length,
    );
  }
  const research = buildTemplate('research', {
    goal: '国际制裁的反制',
    sections: ['问题的提出', '规范基础', '比较法'],
    material: 'D:\\法律法规',
    target: '30000 字',
  });
  const text = JSON.stringify(research.steps);
  check('research uses material path', text.includes('D:\\\\法律法规'));
  check('research has 3 sections', research.steps.filter((step) => ['s1', 's2', 's3'].includes(step.id)).length === 3);
  check('research ends with assemble', research.steps[research.steps.length - 1].id === 'assemble');
  const unknown = (() => {
    try {
      buildTemplate('nope', {});
      return false;
    } catch (err) {
      return /unknown template/.test(err.message);
    }
  })();
  check('unknown template rejected', unknown);
}

async function testMeshPlanTool() {
  const root = tempRoot();
  const sink = [];
  const runtime = apply(makeCtx(sink), settingsFor(root, 'planner'));
  try {
    const tool = sink.find((definition) => definition.name === 'mesh_plan');
    check('mesh_plan tool registered', Boolean(tool));
    const result = await tool.execute({ template: 'code', goal: '做一个 CLI', count: 2, submit: true });
    check('mesh_plan submits when asked', Boolean(result.taskId), JSON.stringify(result).slice(0, 160));
    const paths = buildPaths(root);
    const plan = readJson(paths.plan(result.taskId), null);
    check('submitted plan persisted', Boolean(plan && plan.steps.length >= 4), plan ? String(plan.steps.length) : 'null');
    const preview = await tool.execute({ template: 'drama', goal: '短剧', count: 2 });
    check('mesh_plan previews without submitting', !preview.taskId && preview.plan.steps.length >= 4);
  } finally {
    runtime.stop();
  }
}

async function testCapabilityRouting() {
  const root = tempRoot();
  const paths = buildPaths(root);
  const runtime = apply(makeCtx(), settingsFor(root, 'local-text', { caps: ['text'] }));
  try {
    writeHeartbeat(paths, {
      node: 'remote-img',
      address: '192.168.8.99',
      httpPort: 48902,
      caps: ['text', 'image'],
      capSlots: { image: 1 },
      maxConcurrent: 2,
      role: 'worker',
    });

    const submitted = runtime.submit({
      goal: 'route an image step',
      steps: [{ id: 'img', title: '出图', instruction: '画一张图', caps: ['image'] }],
    });
    await waitFor(() => Boolean(readJson(paths.stepAssign(submitted.taskId, 'img'), null)), 10000, 'assign');
    const assign = readJson(paths.stepAssign(submitted.taskId, 'img'), null);
    check('image step routed to capable node', assign.node === 'remote-img', assign.node);

    const snap = runtime.snapshot();
    check(
      'registry node visible in snapshot',
      snap.nodes.some((entry) => entry.node === 'remote-img' && entry.caps.includes('image')),
      JSON.stringify(snap.nodes),
    );
  } finally {
    runtime.stop();
  }
}

async function testCapSlots() {
  const root = tempRoot();
  const paths = buildPaths(root);
  const runtime = apply(makeCtx(), settingsFor(root, 'local-slot', { caps: ['text'] }));
  try {
    writeHeartbeat(paths, {
      node: 'remote-img-one',
      address: '192.168.8.98',
      httpPort: 48902,
      caps: ['text', 'image'],
      capSlots: { image: 1 },
      maxConcurrent: 4,
      role: 'worker',
    });

    const submitted = runtime.submit({
      goal: 'two image steps, one slot',
      steps: [
        { id: 'a1', title: '图一', instruction: '画图一', caps: ['image'], priority: 10 },
        { id: 'a2', title: '图二', instruction: '画图二', caps: ['image'], priority: 20 },
      ],
    });
    await waitFor(() => Boolean(readJson(paths.stepAssign(submitted.taskId, 'a1'), null)), 10000, 'first assign');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const first = readJson(paths.stepAssign(submitted.taskId, 'a1'), null);
    const second = readJson(paths.stepAssign(submitted.taskId, 'a2'), null);
    check('first image step assigned', Boolean(first));
    check('slot limit blocks the second image step', !second, JSON.stringify(second));
  } finally {
    runtime.stop();
  }
}

async function testPriorityAndBackpressure() {
  const root = tempRoot();
  const paths = buildPaths(root);
  const runtime = apply(
    makeCtx(),
    settingsFor(root, 'local-prio', { caps: ['text'], capSlots: { text: 1 }, maxConcurrent: 1 }),
  );
  try {
    const submitted = runtime.submit({
      goal: 'priority order',
      steps: [
        { id: 'low', title: '低优先级', instruction: '低', priority: 90 },
        { id: 'high', title: '高优先级', instruction: '高', priority: 10 },
      ],
    });
    await waitFor(() => Boolean(readJson(paths.stepAssign(submitted.taskId, 'high'), null)), 10000, 'high assign');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const high = readJson(paths.stepAssign(submitted.taskId, 'high'), null);
    const low = readJson(paths.stepAssign(submitted.taskId, 'low'), null);
    check('high priority dispatched first', Boolean(high));
    check('single text slot defers the low priority step', !low, JSON.stringify(low));
  } finally {
    runtime.stop();
  }

  const root2 = tempRoot();
  const paths2 = buildPaths(root2);
  const runtime2 = apply(makeCtx(), settingsFor(root2, 'local-bp', { caps: ['text'], maxQueuedSteps: 1 }));
  try {
    const submitted = runtime2.submit({
      goal: 'backpressure',
      steps: [
        { id: 'b1', instruction: '一' },
        { id: 'b2', instruction: '二' },
        { id: 'b3', instruction: '三' },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const assigned = ['b1', 'b2', 'b3'].filter((id) => readJson(paths2.stepAssign(submitted.taskId, id), null));
    check('backpressure stops dispatch', assigned.length === 0, assigned.join(','));
    check('backpressure flag visible', runtime2.snapshot().backpressure === true);
  } finally {
    runtime2.stop();
  }
}

await testTemplates();
await testMeshPlanTool();
await testCapabilityRouting();
await testCapSlots();
await testPriorityAndBackpressure();

console.log(failures === 0 ? 'mesh m3 ok' : `mesh m3 FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
