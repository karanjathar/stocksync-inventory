// Engine self-test. Run: node --test engine/selftest.mjs   (Node >= 18, no dependencies)
// Named so project test runners (vitest/jest/pytest) never pick it up.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonc, parseTasks, extractSection, isSecretPath, render } from './engine.mjs';

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'engine.mjs');

function project() {
  const dir = mkdtempSync(path.join(tmpdir(), 'engine-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: dir });
  const run = (args, input) => {
    const r = spawnSync(process.execPath, [ENGINE, ...args], { cwd: dir, env: { ...process.env, ENGINE_ROOT: dir, NO_COLOR: '1' }, encoding: 'utf8', input });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const file = (p) => readFileSync(path.join(dir, p), 'utf8');
  const put = (p, s) => { mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); writeFileSync(path.join(dir, p), s); };
  /** Replace the gates with fast, controllable commands. */
  const setGates = (gates) => {
    const cfg = file('engine.config.jsonc').replace(/"gates": \[[\s\S]*?\n {4}\],/, `"gates": ${JSON.stringify(gates)},`);
    put('engine.config.jsonc', cfg);
  };
  return { dir, run, file, put, setGates };
}

const TASKS = `# 4. Task Graph

## Phase 1: Foundation
- [ ] T01 Set up tooling | accept: gates run | files: package.json
- [ ] T02 Users table | accept: migration applies | refs: 3_SCHEMAS.md#Users | deps: T01

## Phase 2: Features
- [ ] T03 Orders API | accept: POST /orders works | refs: 3_SCHEMAS.md#Orders | deps: T02
`;

describe('pure helpers', () => {
  test('parseJsonc handles comments, trailing commas and comment-like strings', () => {
    const v = parseJsonc('{\n // c\n "a": "http://x//y", /* b */ "b": [1,2,], "c": "/* not */",\n}');
    assert.deepEqual(v, { a: 'http://x//y', b: [1, 2], c: '/* not */' });
  });

  test('parseTasks reads status, phase and metadata', () => {
    const t = parseTasks(TASKS.replace('- [ ] T01', '- [x] T01'));
    assert.equal(t.length, 3);
    assert.deepEqual(t[0], { id: 'T01', status: 'done', title: 'Set up tooling', phase: 'Phase 1: Foundation', line: 3, accept: 'gates run', files: 'package.json', refs: '', deps: [], model: '' });
    assert.deepEqual(t[2].deps, ['T02']);
    assert.equal(t[2].phase, 'Phase 2: Features');
  });

  test('extractSection returns only the requested heading block', () => {
    const md = '# S\n## Users\nu1\n### Fields\nf\n## Orders\no1\n';
    assert.equal(extractSection(md, 'users'), '## Users\nu1\n### Fields\nf');
    assert.equal(extractSection(md, 'Orders'), '## Orders\no1');
    assert.equal(extractSection(md, 'missing'), null);
  });

  test('isSecretPath honours deny and allow globs', () => {
    const sec = { secretFiles: ['.env', '.env.*', '*.pem'], allowSecretFiles: ['.env.example'] };
    assert.equal(isSecretPath('.env', sec), true);
    assert.equal(isSecretPath('api/.env.production', sec), true);
    assert.equal(isSecretPath('certs/server.pem', sec), true);
    assert.equal(isSecretPath('.env.example', sec), false);
    assert.equal(isSecretPath('src/env.ts', sec), false);
  });

  test('render fails loudly on unknown placeholders', () => {
    assert.equal(render('hi {{a.b}}', { a: { b: 'x' } }), 'hi x');
    assert.throws(() => render('{{nope}}', {}), /Unknown placeholder/);
  });
});

describe('init & sync', () => {
  let p;
  before(() => { p = project(); });

  test('init creates config, docs and every tool integration', () => {
    const r = p.run(['init', '--profile', 'python', '--name', 'demo']);
    assert.equal(r.code, 0, r.out);
    const cfg = parseJsonc(p.file('engine.config.jsonc'));
    assert.equal(cfg.project.name, 'demo');
    assert.equal(cfg.stack.profile, 'python');
    assert.ok(cfg.commands.gates.some((g) => g.run === 'uv run pytest -q'));
    for (const f of ['docs/1_PRD.md', 'docs/4_TASKS.md', 'docs/8_DECISIONS.md', 'AGENTS.md', 'CLAUDE.md', '.github/copilot-instructions.md',
      '.clinerules', '.cursor/rules/engine.mdc', '.claude/agents/architect.md', '.claude/commands/engine-build.md',
      '.github/prompts/engine-build.prompt.md', '.claude/settings.json', '.mcp.json', '.vscode/mcp.json', '.github/workflows/engine-ci.yml', '.env.example']) {
      assert.ok(existsSync(path.join(p.dir, f)), `missing ${f}`);
    }
  });

  test('generated files reflect the config (dynamic)', () => {
    assert.match(p.file('AGENTS.md'), /uv run pytest -q/);
    assert.equal(p.file('CLAUDE.md').trim().split('\n').pop(), '@AGENTS.md');
    assert.match(p.file('.claude/agents/architect.md'), /^---\nname: architect\n[\s\S]*model: opus\n---/);
    assert.match(p.file('.claude/agents/implementer.md'), /model: sonnet/);
    // descriptions containing ": " must be quoted or the YAML frontmatter is invalid
    assert.match(p.file('.claude/agents/reviewer.md'), /^description: "Read-only code review of a diff or phase: correctness/m);
    assert.match(p.file('.cursor/rules/engine.mdc'), /^alwaysApply: true$/m);
    assert.match(p.file('.github/prompts/engine-start.prompt.md'), /\$\{input:request/);
    assert.match(p.file('.github/workflows/engine-ci.yml'), /astral-sh\/setup-uv/);
    assert.match(p.file('.gitignore'), /^\.env$/m);
    const hooks = JSON.parse(p.file('.claude/settings.json')).hooks;
    assert.ok(hooks.Stop && hooks.PreToolUse.length === 2);
  });

  test('changing the config and re-syncing updates the rules; sync is idempotent for hooks', () => {
    p.put('engine.config.jsonc', p.file('engine.config.jsonc').replace('"planning": "opus"', '"planning": "sonnet"').replace('"projectRules": []', '"projectRules": ["Money is stored in integer cents"]'));
    assert.equal(p.run(['sync']).code, 0);
    assert.match(p.file('.claude/agents/architect.md'), /model: sonnet/);
    assert.match(p.file('AGENTS.md'), /Money is stored in integer cents/);
    const hooks = JSON.parse(p.file('.claude/settings.json')).hooks;
    assert.equal(hooks.Stop.length, 1, 'hooks must not be duplicated');
  });

  test('sync keeps user-owned files (CI, MCP) unless --force', () => {
    p.put('.mcp.json', '{"mcpServers":{"mine":{}}}');
    p.run(['sync']);
    assert.match(p.file('.mcp.json'), /mine/);
  });

  test('profiles lists all stacks', () => {
    const out = p.run(['profiles']).out;
    for (const id of ['node-ts', 'python', 'dotnet', 'go', 'java-gradle']) assert.match(out, new RegExp(id));
  });
});

describe('build loop enforcement', () => {
  let p;
  before(() => {
    p = project();
    p.run(['init', '--profile', 'node-ts', '--name', 'loop']);
    p.setGates([{ name: 'check', run: 'node -e "process.exit(require(\'fs\').existsSync(\'BROKEN\') ? 1 : 0)"', required: true }]);
    p.put('docs/4_TASKS.md', TASKS);
    p.put('docs/3_SCHEMAS.md', '# Schemas\n## Users\nid uuid, email text\n## Orders\nid uuid, total int\n');
    spawnSync('git', ['add', '-A'], { cwd: p.dir });
    spawnSync('git', ['commit', '-qm', 'init'], { cwd: p.dir });
  });

  test('approving the plan baselines phases that were already complete (brownfield)', () => {
    const q = project();
    q.run(['init', '--profile', 'node-ts', '--name', 'brown']);
    q.put('docs/4_TASKS.md', '# Tasks\n## Legacy\n- [x] T01 Old work\n## New\n- [ ] T02 New work\n');
    q.run(['approve', 'plan']);
    assert.match(q.file('docs/6_STATE_SUMMARY.md'), /- phase Legacy — baseline/);
    assert.match(q.run(['next']).out, /T02/);
  });

  test('CI workflow generation can be disabled', () => {
    const q = project();
    q.run(['init', '--profile', 'node-ts', '--name', 'noci']);
    q.run(['sync']);
    const ci = path.join(q.dir, '.github/workflows/engine-ci.yml');
    spawnSync('rm', ['-f', ci]);
    q.put('engine.config.jsonc', q.file('engine.config.jsonc').replace('"generateWorkflow": true', '"generateWorkflow": false'));
    q.run(['sync']);
    assert.equal(existsSync(ci), false);
  });

  test('next refuses until the plan is approved (checkpoint)', () => {
    const r = p.run(['next']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /CHECKPOINT: the plan has not been approved/);
    assert.equal(p.run(['approve', 'plan']).code, 0);
    assert.match(p.file('docs/6_STATE_SUMMARY.md'), /- plan — approved by Tester/);
  });

  test('next starts the first ready task and writes focused context', () => {
    const r = p.run(['next']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /T01/);
    assert.match(p.file('docs/4_TASKS.md'), /- \[~\] T01/);
    assert.match(p.file('docs/5_CURRENT_TASK.md'), /# Current Task: T01 — Set up tooling/);
  });

  test('done is refused while gates fail', () => {
    p.put('BROKEN', 'x');
    const r = p.run(['done', 'T01', 'Set up the toolchain and gates for the project.']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /NOT completed/);
    assert.match(p.file('docs/4_TASKS.md'), /- \[~\] T01/);
  });

  test('the Stop hook keeps the agent working while a task is open', () => {
    const r = p.run(['hook', 'stop'], JSON.stringify({ stop_hook_active: false }));
    assert.equal(r.code, 2);
    assert.match(r.out, /gates are failing \(check\)/);
    assert.equal(p.run(['hook', 'stop'], JSON.stringify({ stop_hook_active: true })).code, 0, 'never loops forever');
  });

  test('done requires a real summary, then logs and commits', () => {
    require_unlink(p, 'BROKEN');
    assert.notEqual(p.run(['done', 'T01', 'ok']).code, 0);
    const r = p.run(['done', 'T01', 'Set up the toolchain and gates for the project.']);
    assert.equal(r.code, 0, r.out);
    assert.match(p.file('docs/4_TASKS.md'), /- \[x\] T01/);
    assert.match(p.file('docs/6_STATE_SUMMARY.md'), /\*\*T01\*\* Set up tooling .*: Set up the toolchain/);
    assert.match(p.file('docs/5_CURRENT_TASK.md'), /No active task/);
    const log = spawnSync('git', ['log', '-1', '--pretty=%s'], { cwd: p.dir, encoding: 'utf8' }).stdout.trim();
    assert.equal(log, 'feat(T01): Set up tooling');
  });

  test('refs are extracted into the current task (token saver)', () => {
    p.run(['next']);
    const cur = p.file('docs/5_CURRENT_TASK.md');
    assert.match(cur, /T02 — Users table/);
    assert.match(cur, /## Users\nid uuid, email text/);
    assert.doesNotMatch(cur, /total int/, 'unrelated sections must not be included');
  });

  test('secret files are never committed', () => {
    p.put('.env.local', 'API_KEY=real-secret');
    p.put('.gitignore', '# emptied by mistake\n');
    const r = p.run(['done', 'T02', 'Added the users table migration and repository.']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /Refusing to commit secret files: \.env\.local/);
    const tracked = spawnSync('git', ['ls-files'], { cwd: p.dir, encoding: 'utf8' }).stdout;
    assert.doesNotMatch(tracked, /\.env\.local/);
    p.run(['sync']); // restores .gitignore protection
    const ok = p.run(['done', 'T02', 'Added the users table migration and repository.']);
    assert.match(ok.out, /T02 done/);
  });

  test('phase completion enforces the after-phase checkpoint', () => {
    const r = p.run(['next']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /CHECKPOINT: "Phase 1: Foundation" is complete/);
    p.run(['approve', 'phase', 'Phase 1: Foundation']);
    assert.match(p.run(['next']).out, /T03/);
  });

  test('block marks the task and records the reason', () => {
    const r = p.run(['block', 'T03', 'Payment sandbox credentials are missing (401 from provider).']);
    assert.equal(r.code, 0);
    assert.match(p.file('docs/4_TASKS.md'), /- \[!\] T03/);
    assert.match(p.file('docs/6_STATE_SUMMARY.md'), /## Blocked\n- \*\*T03\*\*/);
  });

  test('add-task appends with the next id to an existing or new phase', () => {
    p.run(['add-task', 'Phase 2: Features', 'Retry webhook deliveries | accept: retries 3x | deps: T03']);
    p.run(['add-task', 'Phase 3: Hardening', 'Rate limit login | accept: 429 after 20 tries']);
    const tasks = parseTasks(p.file('docs/4_TASKS.md'));
    assert.deepEqual(tasks.map((t) => [t.id, t.phase]).slice(-2), [['T04', 'Phase 2: Features'], ['T05', 'Phase 3: Hardening']]);
  });

  test('status is compact and informative', () => {
    const out = p.run(['status']).out;
    assert.match(out, /Progress: 2\/5/);
    assert.match(out, /Blocked: T03/);
    assert.ok(out.split('\n').length < 25);
  });

  test('compact archives old log entries', () => {
    const extra = Array.from({ length: 40 }, (_, i) => `- **T9${i}** old (2026-01-01): entry ${i}`).join('\n');
    p.put('docs/6_STATE_SUMMARY.md', p.file('docs/6_STATE_SUMMARY.md').replace('## Log\n', `## Log\n${extra}\n`));
    assert.match(p.run(['compact']).out, /archived \d+ entries/);
    const kept = p.file('docs/6_STATE_SUMMARY.md').split('\n').filter((l) => l.startsWith('- **T')).length;
    assert.ok(kept <= 16, `kept ${kept}`);
    assert.match(p.file('docs/archive/state-log.md'), /entry 0/);
  });
});

describe('guard hooks', () => {
  let p;
  before(() => { p = project(); p.run(['init', '--profile', 'go', '--name', 'guards']); });

  test('pre-edit blocks secret files but allows .env.example', () => {
    assert.equal(p.run(['hook', 'pre-edit'], JSON.stringify({ tool_input: { file_path: path.join(p.dir, '.env') } })).code, 2);
    assert.equal(p.run(['hook', 'pre-edit'], JSON.stringify({ tool_input: { file_path: path.join(p.dir, '.env.example') } })).code, 0);
    assert.equal(p.run(['hook', 'pre-edit'], JSON.stringify({ tool_input: { file_path: 'src/main.go' } })).code, 0);
  });

  test('pre-bash blocks dangerous commands only', () => {
    const code = (command) => p.run(['hook', 'pre-bash'], JSON.stringify({ tool_input: { command } })).code;
    assert.equal(code('git push --force origin main'), 2);
    assert.equal(code('git add .env'), 2);
    assert.equal(code('git commit --no-verify -m x'), 2);
    assert.equal(code('rm -rf /'), 2);
    assert.equal(code('git push --force-with-lease origin feat'), 0);
    assert.equal(code('git add .env.example src/'), 0);
    assert.equal(code('rm -rf dist'), 0);
  });
});

function require_unlink(p, f) {
  spawnSync(process.platform === 'win32' ? 'del' : 'rm', ['-f', path.join(p.dir, f)], { shell: process.platform === 'win32' });
}
