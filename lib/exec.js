// dsh-mesh: step executor.
// Runs one agent turn in an isolated profile and returns its final text.
// We spawn the Electron binary in node mode with an argv array (no shell), so
// Chinese instructions and paths with spaces survive untouched.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './store.js';

const MAX_INSTRUCTION_CHARS = 30000;

export function killTree(pid) {
  if (!pid) return;
  try {
    spawn('taskkill', ['/F', '/T', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    /* best effort */
  }
}

function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      events.push(JSON.parse(text));
    } catch {
      /* ignore partial line */
    }
  }
  return events;
}

function finalText(events) {
  const final = [...events].reverse().find((event) => event.type === 'final' && typeof event.text === 'string');
  if (final) return final.text;
  const parts = events.filter((event) => event.type === 'text' && typeof event.text === 'string');
  return parts.map((event) => event.text).join('');
}

function fakeRun({ instruction, logPath, cwd }) {
  return new Promise((resolve, reject) => {
    ensureDir(cwd);
    const fail = instruction.includes('[[FAIL]]');
    const text = `[fake] ${instruction.replace('[[FAIL]]', '').slice(0, 200)}`;
    const log = [`fake exec cwd=${cwd}`, `fake exec text=${text}`].join('\n');
    try {
      fs.writeFileSync(logPath, log);
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      if (fail) reject(new Error('fake executor failure'));
      else resolve({ text, events: [], code: 0, stderr: '', ms: 50, timedOut: false });
    }, fail ? 30 : 80);
  });
}

export async function runStep({
  dshExe,
  dshCli,
  profile,
  instruction,
  cwd,
  timeoutMs,
  logPath,
  envExtra = {},
  fake = false,
}) {
  let task = String(instruction || '');
  if (task.length > MAX_INSTRUCTION_CHARS) {
    task = `${task.slice(0, MAX_INSTRUCTION_CHARS)}\n\n[instruction truncated: ${task.length - MAX_INSTRUCTION_CHARS} chars]`;
  }
  ensureDir(cwd);
  ensureDir(path.dirname(logPath));
  if (fake) return fakeRun({ instruction: task, logPath, cwd });

  const started = Date.now();
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...envExtra };
  const child = spawn(
    dshExe,
    ['--expose-internals', dshCli, '--profile', profile, 'headless', '--json', task],
    { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child.pid);
  }, Math.max(5000, Number(timeoutMs) || 900000));

  const code = await new Promise((resolve) => {
    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      resolve(-1);
    });
    child.on('close', (exitCode) => resolve(exitCode ?? -1));
  });
  clearTimeout(timer);

  const events = parseEvents(stdout);
  const text = finalText(events);
  const ms = Date.now() - started;
  try {
    fs.writeFileSync(
      logPath,
      [
        `# cmd: ${dshExe} --expose-internals ${dshCli} --profile ${profile} headless --json <task>`,
        `# cwd: ${cwd}`,
        `# exit: ${code} elapsed_ms: ${ms} timed_out: ${timedOut}`,
        '# --- stdout ---',
        stdout,
        '# --- stderr ---',
        stderr,
      ].join('\n'),
    );
  } catch {
    /* log is best effort */
  }

  if (timedOut) {
    const error = new Error(`step timed out after ${Math.round(ms / 1000)}s`);
    error.code = 'TIMEOUT';
    error.text = text;
    throw error;
  }
  if (!text && code !== 0) {
    const error = new Error(`executor exited ${code}: ${stderr.trim().split(/\r?\n/).slice(-3).join(' | ') || 'no output'}`);
    error.code = 'EXEC_FAILED';
    throw error;
  }
  return { text, events, code, stderr, ms, timedOut };
}
