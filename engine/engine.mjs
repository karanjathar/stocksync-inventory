#!/usr/bin/env node
// AI Project Engine v2 — zero-dependency CLI (Node >= 18).
// The engine *enforces* the workflow so it doesn't depend on the AI remembering rules:
//   tasks can't be completed with failing gates, phases can't advance without human approval,
//   secret files can't be committed, and context files stay small.
//
// Usage: node engine/engine.mjs <command> [...args]     (run with "help" for the list)

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.ENGINE_ROOT ? path.resolve(process.env.ENGINE_ROOT) : path.resolve(ENGINE_DIR, '..');
const CONFIG_FILE = path.join(ROOT, 'engine.config.jsonc');
const DOCS = path.join(ROOT, 'docs');
const STATE_DIR = path.join(ROOT, '.engine');
const ENGINE_CMD = 'node engine/engine.mjs';
const F = {
  prd: path.join(DOCS, '1_PRD.md'),
  arch: path.join(DOCS, '2_ARCHITECTURE.md'),
  schemas: path.join(DOCS, '3_SCHEMAS.md'),
  tasks: path.join(DOCS, '4_TASKS.md'),
  current: path.join(DOCS, '5_CURRENT_TASK.md'),
  state: path.join(DOCS, '6_STATE_SUMMARY.md'),
  audit: path.join(DOCS, '7_SECURITY_AUDIT.md'),
  decisions: path.join(DOCS, '8_DECISIONS.md'),
};

// ---------------------------------------------------------------- utilities

export class EngineError extends Error {}
const fail = (msg) => { throw new EngineError(msg); };
const read = (p) => readFileSync(p, 'utf8');
const write = (p, s) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, s); };
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const today = () => new Date().toISOString().slice(0, 10);
const color = process.stdout.isTTY && !process.env.NO_COLOR && !process.argv.includes('--ci');
const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s) => c(32, s), red = (s) => c(31, s), yellow = (s) => c(33, s), dim = (s) => c(2, s), bold = (s) => c(1, s);

/** JSON with // and /* *\/ comments and trailing commas (string-aware). */
export function parseJsonc(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const ch = text[i], next = text[i + 1];
    if (inStr) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; i++; continue; }
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += ch;
    i++;
  }
  // remove trailing commas outside strings
  let res = '';
  inStr = false;
  for (let j = 0; j < out.length; j++) {
    const ch = out[j];
    if (inStr) { res += ch; if (ch === '\\') { res += out[++j] ?? ''; } else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; res += ch; continue; }
    if (ch === ',') {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k])) k++;
      if (out[k] === '}' || out[k] === ']') continue;
    }
    res += ch;
  }
  return JSON.parse(res);
}

function sh(cmd, opts = {}) {
  return spawnSync(cmd, { cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
}
function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
const isGitRepo = () => git(['rev-parse', '--is-inside-work-tree']).ok;

function globToRegex(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`(^|/)${esc}$`);
}
export function isSecretPath(file, security) {
  const p = file.split(path.sep).join('/');
  const allowed = (security?.allowSecretFiles ?? []).some((g) => globToRegex(g).test(p));
  if (allowed) return false;
  return (security?.secretFiles ?? []).some((g) => globToRegex(g).test(p));
}

// ---------------------------------------------------------------- config & profiles

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) fail(`No engine.config.jsonc found. Run: ${ENGINE_CMD} init --profile <id>`);
  const cfg = parseJsonc(read(CONFIG_FILE));
  const problems = [];
  if (!cfg.project?.name) problems.push('project.name is required');
  if (!Array.isArray(cfg.commands?.gates) || !cfg.commands.gates.length) problems.push('commands.gates must list at least one gate');
  for (const g of cfg.commands?.gates ?? []) if (!g.name || !g.run) problems.push(`gate ${JSON.stringify(g)} needs "name" and "run"`);
  if (!['task', 'phase', 'all'].includes(cfg.autonomy?.mode)) problems.push('autonomy.mode must be "task", "phase" or "all"');
  if (problems.length) fail(`engine.config.jsonc is invalid:\n  - ${problems.join('\n  - ')}`);
  return cfg;
}

export function listProfiles() {
  return readdirSync(path.join(ENGINE_DIR, 'profiles')).filter((f) => f.endsWith('.jsonc')).map((f) => {
    const p = parseJsonc(read(path.join(ENGINE_DIR, 'profiles', f)));
    return { id: p.id, label: p.label, file: f, profile: p };
  });
}

// ---------------------------------------------------------------- tasks

const TASK_RE = /^- \[( |x|~|!)\] (T\d+)\s+(.*)$/;
const STATUS = { ' ': 'todo', x: 'done', '~': 'active', '!': 'blocked' };

export function parseTasks(text) {
  const tasks = [];
  let phase = 'Unphased';
  text.split('\n').forEach((line, index) => {
    const ph = /^##\s+(.+?)\s*$/.exec(line);
    if (ph) { phase = ph[1]; return; }
    const m = TASK_RE.exec(line);
    if (!m) return;
    const [title, ...fields] = m[3].split(' | ');
    const meta = {};
    for (const f of fields) {
      const kv = /^(\w+):\s*(.*)$/.exec(f.trim());
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
    }
    tasks.push({
      id: m[2], status: STATUS[m[1]], title: title.trim(), phase, line: index,
      accept: meta.accept ?? '', files: meta.files ?? '', refs: meta.refs ?? '',
      deps: (meta.deps ?? '').split(/[,\s]+/).filter((d) => /^T\d+$/.test(d)),
      model: meta.model ?? '',
    });
  });
  return tasks;
}

function setTaskStatus(id, mark) {
  const lines = read(F.tasks).split('\n');
  const idx = lines.findIndex((l) => TASK_RE.test(l) && TASK_RE.exec(l)[2] === id);
  if (idx < 0) fail(`Task ${id} not found in docs/4_TASKS.md`);
  lines[idx] = lines[idx].replace(/^- \[.\]/, `- [${mark}]`);
  write(F.tasks, lines.join('\n'));
}

function phases(tasks) {
  const order = [];
  for (const t of tasks) if (!order.includes(t.phase)) order.push(t.phase);
  return order.map((name) => {
    const ts = tasks.filter((t) => t.phase === name);
    return { name, tasks: ts, done: ts.filter((t) => t.status === 'done').length, total: ts.length };
  });
}

// ---------------------------------------------------------------- state summary & approvals

function stateText() {
  if (!existsSync(F.state)) write(F.state, renderTemplate('docs/6_STATE_SUMMARY.md', baseContext(null)));
  return read(F.state);
}
function sectionBounds(lines, heading) {
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  return { start, end };
}
function appendToSection(heading, entry) {
  const lines = stateText().split('\n');
  let b = sectionBounds(lines, heading);
  if (!b) { lines.push('', `## ${heading}`, ''); b = sectionBounds(lines, heading); }
  let insertAt = b.end;
  while (insertAt > b.start + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, entry);
  write(F.state, lines.join('\n'));
}
function sectionEntries(heading) {
  const lines = stateText().split('\n');
  const b = sectionBounds(lines, heading);
  return b ? lines.slice(b.start + 1, b.end).filter((l) => l.startsWith('- ')) : [];
}
export function approvals() {
  return sectionEntries('Approvals').map((l) => l.slice(2));
}
const isApproved = (key) => approvals().some((a) => a.toLowerCase().startsWith(key.toLowerCase() + ' '));

// ---------------------------------------------------------------- context extraction

/** Returns the markdown section under the first heading containing `name` (case-insensitive). */
export function extractSection(markdown, name) {
  const lines = markdown.split('\n');
  const idx = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, '').toLowerCase().includes(name.toLowerCase()));
  if (idx < 0) return null;
  const level = /^#+/.exec(lines[idx])[0].length;
  let end = lines.findIndex((l, i) => i > idx && /^#{1,6}\s/.test(l) && /^#+/.exec(l)[0].length <= level);
  if (end < 0) end = lines.length;
  return lines.slice(idx, end).join('\n').trim();
}

function refContext(refs) {
  const parts = [];
  for (const ref of refs.split(',').map((r) => r.trim()).filter(Boolean)) {
    const [file, anchor] = ref.split('#');
    const p = path.join(DOCS, file.endsWith('.md') ? file : `${file}.md`);
    if (!existsSync(p)) { parts.push(`> ⚠ ref not found: ${ref}`); continue; }
    const body = anchor ? extractSection(read(p), anchor) : read(p);
    parts.push(body ? `<!-- ${ref} -->\n${body}` : `> ⚠ section "${anchor}" not found in ${file}`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------- gates

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
function tail(text, n) {
  const lines = text.replace(ANSI, '').replace(/\s+$/, '').split('\n');
  return lines.length <= n ? lines.join('\n') : `${dim(`… ${lines.length - n} earlier lines hidden …`)}\n${lines.slice(-n).join('\n')}`;
}

function withoutColor(env) {
  const e = { ...env };
  delete e.FORCE_COLOR; // some tools treat any FORCE_COLOR value as "on"
  return e;
}

export function runGates(cfg, { only, quiet = false } = {}) {
  const gates = cfg.commands.gates.filter((g) => !only || only.includes(g.name));
  const n = cfg.context?.gateOutputLines ?? 60;
  const results = [];
  for (const g of gates) {
    const t0 = Date.now();
    const r = sh(g.run, { env: { ...withoutColor(process.env), NO_COLOR: '1' } });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const ok = r.status === 0;
    const required = g.required !== false;
    results.push({ name: g.name, ok, required, status: r.status, secs });
    if (quiet) continue;
    if (ok) console.log(`${green('✔')} ${g.name} ${dim(`${secs}s`)}`);
    else {
      const label = required ? red('✘') : yellow('⚠ (optional)');
      const hint = r.status === 127 ? ' — command not found; install the tool or fix commands.gates in engine.config.jsonc' : '';
      console.log(`${label} ${g.name} ${dim(`exit ${r.status}, ${secs}s`)}${hint}  ${dim(`$ ${g.run}`)}`);
      // Token saver: only the tail of failing output is shown.
      console.log(tail(`${r.stdout ?? ''}\n${r.stderr ?? ''}`, n));
    }
  }
  const ok = results.every((r) => r.ok || !r.required);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(path.join(STATE_DIR, 'last-gate.json'), JSON.stringify({ ok, at: new Date().toISOString(), results }, null, 2));
  return { ok, results };
}

// ---------------------------------------------------------------- templates & sync

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function render(template, ctx, name = 'template') {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const v = getPath(ctx, key);
    if (v === undefined) fail(`Unknown placeholder {{${key}}} in ${name}`);
    return Array.isArray(v) ? v.join('\n') : String(v);
  });
}
function renderTemplate(name, ctx) {
  return render(read(path.join(ENGINE_DIR, 'templates', name)), ctx, name);
}

function baseContext(cfg) {
  const gates = cfg?.commands?.gates ?? [];
  return {
    engine: ENGINE_CMD,
    today: today(),
    cfg: cfg ?? {},
    project: cfg?.project ?? { name: 'project', goal: '' },
    stack: cfg?.stack ?? {},
    autonomy: cfg?.autonomy ?? { mode: 'phase', maxFixAttempts: 3 },
    gateList: gates.map((g) => `- **${g.name}**${g.required === false ? ' (optional)' : ''}: \`${g.run}\``).join('\n'),
    gateNames: gates.map((g) => g.name).join(' → '),
    checkpoints: (cfg?.checkpoints ?? []).map((c) => `\`${c}\``).join(', ') || '_none_',
    conventions: (cfg?.stack?.conventions ?? []).map((r) => `- ${r}`).join('\n') || '- _(none)_',
    projectRules: (cfg?.projectRules ?? []).map((r) => `- ${r}`).join('\n') || '- _(none yet — add in engine.config.jsonc → projectRules)_',
    installCmd: cfg?.commands?.install ?? '',
    devCmd: cfg?.commands?.dev ?? '',
    deployTarget: cfg?.deploy?.target ?? 'unspecified',
    deployEnvs: (cfg?.deploy?.environments ?? []).join(' → '),
    clearAfter: cfg?.context?.clearAfter ?? 'phase',
    generatedNote: `<!-- GENERATED by \`${ENGINE_CMD} sync\` from engine.config.jsonc + engine/templates. Do not edit here. -->`,
  };
}

// Role → [description, model tier, Claude tools]
const AGENTS = {
  architect: ['System design: PRD, architecture, schemas, task graph, re-planning. Use for /engine-plan and /engine-replan.', 'planning', 'Read, Grep, Glob, Write, Edit, WebFetch, WebSearch'],
  implementer: ['Implements ONE task from docs/5_CURRENT_TASK.md with TDD and runs the gates. Use for each build task.', 'coding', 'Read, Grep, Glob, Write, Edit, Bash'],
  reviewer: ['Read-only code review of a diff or phase: correctness, simplicity, test gaps. Never edits files.', 'review', 'Read, Grep, Glob, Bash'],
  'security-auditor': ['Security audit of the codebase and dependencies; writes docs/7_SECURITY_AUDIT.md and proposes fixes.', 'planning', 'Read, Grep, Glob, Write, Edit, Bash, WebFetch'],
  devops: ['Containers, CI/CD, infrastructure-as-code and deployment guides for the configured deploy target.', 'planning', 'Read, Grep, Glob, Write, Edit, Bash, WebFetch'],
};

// Command → [description, model tier, Claude subagent hint]
const COMMANDS = {
  'engine-start': ['Phase 0 — discovery: interview me, fill engine.config.jsonc and docs/1_PRD.md', 'planning'],
  'engine-plan': ['Phase 1 — architecture, schemas and task graph (stops for approval)', 'planning'],
  'engine-build': ['Phase 2 — build tasks with TDD until the autonomy limit or a checkpoint', 'coding'],
  'engine-resume': ['Resume after /clear or a new session using compact state', 'fast'],
  'engine-replan': ['Change scope: add/split/reorder tasks and record the decision', 'planning'],
  'engine-review': ['Review the work of the last phase (read-only) and file fix tasks', 'review'],
  'engine-audit': ['Phase 3 — security & quality audit before deployment', 'planning'],
  'engine-deploy': ['Phase 4 — containers, CI/CD and deployment for the configured target', 'planning'],
};

function yamlScalar(v) {
  const s = String(v);
  // Quote anything YAML could misread (": ", leading specials, '#'); JSON strings are valid YAML.
  return /^[\w./@-][\w ./@,|()-]*$/.test(s) && !/:\s|\s#/.test(s) ? s : JSON.stringify(s);
}
function frontmatter(obj) {
  const lines = Object.entries(obj).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}: ${yamlScalar(v)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

export function syncFiles(cfg, { force = false } = {}) {
  const ctx = baseContext(cfg);
  const written = [];
  const managed = (rp, content) => { write(path.join(ROOT, rp), content); written.push(rp); };
  const once = (rp, content) => {
    const p = path.join(ROOT, rp);
    if (!force && existsSync(p)) return;
    write(p, content);
    written.push(rp);
  };
  const modelFor = (tool, tier) => cfg.models?.[tool]?.[tier] ?? '';

  // 1. Canonical rules + thin pointers for every tool.
  managed('AGENTS.md', renderTemplate('AGENTS.md', ctx));
  managed('CLAUDE.md', `${ctx.generatedNote}\n@AGENTS.md\n`);
  managed('.github/copilot-instructions.md', renderTemplate('pointer.md', ctx));
  managed('.clinerules', renderTemplate('pointer.md', ctx));
  managed('.cursor/rules/engine.mdc', `${frontmatter({ description: 'AI Project Engine rules', alwaysApply: 'true' })}${renderTemplate('pointer.md', ctx)}`);

  // 2. Claude Code subagents (model routing) and slash commands.
  for (const [name, [description, tier, tools]] of Object.entries(AGENTS)) {
    const body = renderTemplate(`agents/${name}.md`, ctx);
    managed(`.claude/agents/${name}.md`, `${frontmatter({ name, description, tools, model: modelFor('claude', tier) || 'inherit' })}${body}`);
  }
  for (const [name, [description, tier]] of Object.entries(COMMANDS)) {
    const body = renderTemplate(`commands/${name}.md`, ctx);
    managed(`.claude/commands/${name}.md`, `${frontmatter({ description, model: modelFor('claude', tier) })}${body}`);
    // 3. Same commands as VS Code Copilot prompt files.
    const copilotBody = body.replaceAll('$ARGUMENTS', '${input:request:Describe what you want}');
    managed(`.github/prompts/${name}.prompt.md`, `${frontmatter({ mode: 'agent', description, model: modelFor('copilot', tier) })}${copilotBody}`);
  }

  // 4. Hooks (Claude Code) — merged into existing settings, never clobbered.
  const settingsPath = path.join(ROOT, '.claude/settings.json');
  const settings = existsSync(settingsPath) ? JSON.parse(read(settingsPath)) : {};
  settings.hooks ??= {};
  const ensureHook = (event, matcher, command) => {
    settings.hooks[event] ??= [];
    const exists = settings.hooks[event].some((h) => (h.hooks ?? []).some((x) => x.command === command));
    if (!exists) settings.hooks[event].push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command }] });
  };
  const hookCmd = (name) => `node "$CLAUDE_PROJECT_DIR/engine/engine.mjs" hook ${name}`;
  if (cfg.hooks?.guardSecrets !== false) {
    ensureHook('PreToolUse', 'Edit|Write|MultiEdit', hookCmd('pre-edit'));
    ensureHook('PreToolUse', 'Bash', hookCmd('pre-bash'));
  }
  if (cfg.hooks?.gateOnStop !== false) ensureHook('Stop', null, hookCmd('stop'));
  managed('.claude/settings.json', `${JSON.stringify(settings, null, 2)}\n`);

  // 5. MCP servers (created once; yours afterwards).
  const mcp = cfg.mcp?.servers ?? {};
  once('.mcp.json', `${JSON.stringify({ mcpServers: mcp }, null, 2)}\n`);
  const vscodeServers = Object.fromEntries(Object.entries(mcp).map(([k, v]) => [k, { type: 'stdio', ...v }]));
  once('.vscode/mcp.json', `${JSON.stringify({ servers: vscodeServers }, null, 2)}\n`);

  // 6. CI workflow (created once; extend it freely afterwards).
  const ciSetup = (cfg.stack?.ci?.setup ?? []).map((l) => `      ${l}`).join('\n');
  if (cfg.ci?.generateWorkflow !== false) once('.github/workflows/engine-ci.yml', render(read(path.join(ENGINE_DIR, 'templates/ci.yml')), { ...ctx, ciSetup: ciSetup || '      # (no runtime setup needed)' }, 'ci.yml'));

  // 7. .gitignore essentials.
  const giPath = path.join(ROOT, '.gitignore');
  const gi = existsSync(giPath) ? read(giPath) : '';
  const need = ['.env', '.env.*', '!.env.example', '.engine/', ...(cfg.stack?.gitignore ?? [])].filter((l) => !gi.split('\n').includes(l));
  if (need.length) { write(giPath, `${gi}${gi && !gi.endsWith('\n') ? '\n' : ''}${gi ? '\n' : ''}# AI Project Engine\n${need.join('\n')}\n`); written.push('.gitignore'); }
  return written;
}

// ---------------------------------------------------------------- commands

const commands = {};

commands.help = () => {
  console.log(`${bold('AI Project Engine v2')}  —  ${ENGINE_CMD} <command>

  ${bold('Setup')}
    init --profile <id> [--name <n>] [--force]   create engine.config.jsonc + docs, then sync
    profiles                                      list stack profiles
    sync [--force]                                regenerate AGENTS.md, tool files, agents, commands, hooks
    doctor                                        check tools, config and generated files

  ${bold('Build loop')}
    next                                          start the next ready task → writes docs/5_CURRENT_TASK.md
    gate [--only a,b] [--ci]                      run quality gates (compact output)
    done <T#> "<2-sentence summary>" [--no-commit]   gates → mark done → log → commit
    block <T#> "<reason>"                         mark blocked and stop
    add-task "<Phase heading>" "<title | accept: … | files: … | refs: … | deps: …>"

  ${bold('Control')}
    status                                        compact progress (use after /clear)
    approve <plan|phase|deploy> [name]            record a human approval (humans only)
    compact                                       archive old state-summary entries
`);
};

commands.profiles = () => {
  for (const p of listProfiles()) console.log(`${bold(p.id.padEnd(12))} ${p.label}  ${dim(p.profile.description ?? '')}`);
};

commands.init = (args) => {
  const opt = flags(args);
  const profiles = listProfiles();
  const profile = profiles.find((p) => p.id === (opt.profile ?? 'node-ts'));
  if (!profile) fail(`Unknown profile "${opt.profile}". Available: ${profiles.map((p) => p.id).join(', ')}`);
  if (existsSync(CONFIG_FILE) && !opt.force) {
    console.log(yellow('engine.config.jsonc already exists — keeping it (use --force to overwrite).'));
  } else {
    const p = profile.profile;
    const name = opt.name ?? path.basename(ROOT);
    const tpl = read(path.join(ENGINE_DIR, 'templates/engine.config.jsonc'));
    const cfgText = render(tpl, {
      name: JSON.stringify(name),
      profileId: JSON.stringify(p.id),
      stackDescription: JSON.stringify(p.description ?? ''),
      install: JSON.stringify(p.commands.install ?? ''),
      dev: JSON.stringify(p.commands.dev ?? ''),
      gates: p.commands.gates.map((g) => `      ${JSON.stringify(g)},`).join('\n'),
      conventions: (p.conventions ?? []).map((cv) => `      ${JSON.stringify(cv)},`).join('\n'),
      gitignore: JSON.stringify(p.gitignore ?? []),
      ciSetup: JSON.stringify(p.ci?.setup ?? []),
    }, 'engine.config.jsonc');
    parseJsonc(cfgText); // validate before writing
    write(CONFIG_FILE, cfgText);
    console.log(`${green('✔')} engine.config.jsonc (profile: ${p.id})`);
  }
  const cfg = loadConfig();
  const ctx = baseContext(cfg);
  for (const doc of readdirSync(path.join(ENGINE_DIR, 'templates/docs'))) {
    const target = path.join(DOCS, doc);
    if (existsSync(target)) continue;
    write(target, renderTemplate(`docs/${doc}`, ctx));
    console.log(`${green('✔')} docs/${doc}`);
  }
  if (!existsSync(path.join(ROOT, '.env.example'))) write(path.join(ROOT, '.env.example'), '# Every environment variable the app reads, with DUMMY values only.\n');
  const files = syncFiles(cfg);
  console.log(`${green('✔')} synced ${files.length} files`);
  console.log(`\nNext: open your AI assistant in this folder and run ${bold('/engine-start')}  (Copilot: the "engine-start" prompt).`);
};

commands.sync = (args) => {
  const files = syncFiles(loadConfig(), { force: args.includes('--force') });
  console.log(files.length ? files.map((f) => `${green('✔')} ${f}`).join('\n') : 'Everything up to date.');
};

commands.gate = (args) => {
  const cfg = loadConfig();
  const opt = flags(args);
  const only = opt.only ? String(opt.only).split(',') : undefined;
  const { ok } = runGates(cfg, { only });
  console.log(ok ? green('\nALL REQUIRED GATES PASSED') : red('\nGATES FAILED — fix the root cause (no suppressions, no `any`, no skipped tests).'));
  process.exitCode = ok ? 0 : 1;
};

commands.next = () => {
  const cfg = loadConfig();
  if (!existsSync(F.tasks)) fail('docs/4_TASKS.md not found — run /engine-plan first.');
  const tasks = parseTasks(read(F.tasks));
  if (!tasks.length) fail('docs/4_TASKS.md has no tasks yet — run /engine-plan first.');
  const cps = cfg.checkpoints ?? [];
  if (cps.includes('after-plan') && !isApproved('plan')) {
    fail(`CHECKPOINT: the plan has not been approved.\nA human must review docs/1–4 and run: ${ENGINE_CMD} approve plan`);
  }
  const active = tasks.find((t) => t.status === 'active');
  if (active) {
    console.log(`Task ${active.id} is already in progress — continue it (see docs/5_CURRENT_TASK.md).`);
    return;
  }
  const done = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  const allPhases = phases(tasks);
  const next = tasks.find((t) => t.status === 'todo' && t.deps.every((d) => done.has(d)));
  if (!next) {
    const blocked = tasks.filter((t) => t.status === 'blocked');
    const waiting = tasks.filter((t) => t.status === 'todo');
    if (!waiting.length && !blocked.length) { console.log(green('ALL TASKS COMPLETE. Next: /engine-review, then /engine-audit.')); return; }
    fail(`No task is ready. Blocked: ${blocked.map((t) => t.id).join(', ') || 'none'}; waiting on deps: ${waiting.map((t) => `${t.id}(${t.deps.join(',')})`).join(' ') || 'none'}`);
  }
  // Phase checkpoint: every earlier phase must be complete and (if configured) approved.
  const phaseIdx = allPhases.findIndex((p) => p.name === next.phase);
  for (const p of allPhases.slice(0, phaseIdx)) {
    if (p.done < p.total) continue; // earlier phase still has blocked tasks but deps allowed this one
    if (cps.includes('after-phase') && !isApproved(`phase ${p.name}`)) {
      fail(`CHECKPOINT: "${p.name}" is complete and needs human review.\nRun /engine-review, then a human runs: ${ENGINE_CMD} approve phase "${p.name}"`);
    }
  }
  setTaskStatus(next.id, '~');
  const gates = cfg.commands.gates.map((g) => `- ${g.name}: \`${g.run}\`${g.required === false ? ' _(optional)_' : ''}`).join('\n');
  const ctxRefs = next.refs ? refContext(next.refs) : '_No refs on this task. If you need a contract, open only the matching section of docs/3_SCHEMAS.md._';
  const content = `# Current Task: ${next.id} — ${next.title}
Phase: ${next.phase} · Started: ${new Date().toISOString()}${next.model ? ` · Model tier: ${next.model}` : ''}

## Acceptance criteria
${next.accept || '_Not specified — derive from docs/1_PRD.md and state them in the first test._'}

## Files to touch
${next.files || '_Decide from docs/2_ARCHITECTURE.md (directory layout)._'}

## Context (auto-extracted — read this instead of whole documents)
${ctxRefs}

## Procedure
1. Write a failing test for the acceptance criteria; run it and confirm it fails for the right reason.
2. Implement the minimum code to pass. Surgical edits only.
3. Run \`${ENGINE_CMD} gate\`. On failure fix the root cause — max ${cfg.autonomy?.maxFixAttempts ?? 3} attempts, then \`${ENGINE_CMD} block ${next.id} "<reason>"\` and stop.
4. Finish with \`${ENGINE_CMD} done ${next.id} "<what was built + any decision, 2 sentences>"\` (re-runs gates, logs, commits).

## Gates
${gates}
`;
  write(F.current, content.replace(ANSI, ''));
  console.log(`${bold(`▶ ${next.id}`)} ${next.title}  ${dim(`(${next.phase})`)}\n  → wrote docs/5_CURRENT_TASK.md — read ONLY that file plus the files it lists.`);
};

commands.done = (args) => {
  const cfg = loadConfig();
  const id = args[0];
  const summary = args.slice(1).filter((a) => !a.startsWith('--')).join(' ').trim();
  if (!/^T\d+$/.test(id ?? '')) fail('Usage: done <T#> "<2-sentence summary>"');
  if (summary.length < 20) fail('A meaningful summary (what was built + any decision, ~2 sentences) is required.');
  const task = parseTasks(read(F.tasks)).find((t) => t.id === id);
  if (!task) fail(`Task ${id} not found.`);
  if (task.status === 'done') fail(`Task ${id} is already done.`);

  console.log(dim(`Running gates for ${id}…`));
  const { ok } = runGates(cfg);
  if (!ok) { process.exitCode = 1; fail(`${id} NOT completed: required gates failed. Fix the root cause and run done again.`); }

  // Secret guard BEFORE mutating any state, so a refused commit leaves the task open and retryable.
  const shouldCommit = !args.includes('--no-commit') && cfg.git?.commitPerTask !== false && isGitRepo();
  if (shouldCommit) {
    git(['add', '-A']);
    const staged = git(['diff', '--cached', '--name-only']).out.split('\n').filter(Boolean);
    const secrets = staged.filter((f) => isSecretPath(f, cfg.security));
    if (secrets.length) {
      git(['reset', '-q', '--', ...secrets]);
      process.exitCode = 1;
      fail(`Refusing to commit secret files: ${secrets.join(', ')}. They were unstaged and the task is still open; fix .gitignore (\`${ENGINE_CMD} sync\`) and run done again.`);
    }
  }

  setTaskStatus(id, 'x');
  appendToSection('Log', `- **${id}** ${task.title} (${today()}): ${summary}`);
  write(F.current, renderTemplate('docs/5_CURRENT_TASK.md', baseContext(cfg)));
  const logCount = sectionEntries('Log').length;
  if (logCount > (cfg.context?.stateSummaryKeep ?? 15) * 2) compactState(cfg, true);

  let commitInfo = 'not committed';
  if (shouldCommit) {
    git(['add', '-A']);
    const lateSecrets = git(['diff', '--cached', '--name-only']).out.split('\n').filter((f) => f && isSecretPath(f, cfg.security));
    if (lateSecrets.length) git(['reset', '-q', '--', ...lateSecrets]);
    const trailer = cfg.git?.commitTrailer ? `\n\n${cfg.git.commitTrailer}` : '';
    const r = git(['commit', '-q', '-m', `feat(${id}): ${task.title}${trailer}`]);
    commitInfo = r.ok ? `commit ${git(['rev-parse', '--short', 'HEAD']).out}` : `commit skipped (${r.err || r.out || 'nothing to commit'})`;
  }
  console.log(`${green('✔')} ${id} done · ${commitInfo}`);

  const tasks = parseTasks(read(F.tasks));
  const ph = phases(tasks).find((p) => p.name === task.phase);
  if (ph && ph.done === ph.total) {
    const cp = (cfg.checkpoints ?? []).includes('after-phase');
    console.log(bold(`\n■ PHASE COMPLETE: ${ph.name}`) + (cp ? `\n  CHECKPOINT → stop. Run /engine-review; a human approves with: ${ENGINE_CMD} approve phase "${ph.name}"` : ''));
    if (cfg.context?.clearAfter === 'phase') console.log(dim('  Context tip: this is a good moment to /clear, then /engine-resume.'));
  }
  const mode = cfg.autonomy?.mode ?? 'phase';
  if (mode === 'task') console.log(`Autonomy "task": stop here and report.`);
};

commands.block = (args) => {
  loadConfig();
  const [id, ...rest] = args;
  const reason = rest.join(' ').trim();
  if (!/^T\d+$/.test(id ?? '') || !reason) fail('Usage: block <T#> "<reason incl. the exact error>"');
  setTaskStatus(id, '!');
  appendToSection('Blocked', `- **${id}** (${today()}): ${reason}`);
  write(F.current, renderTemplate('docs/5_CURRENT_TASK.md', baseContext(loadConfig())));
  console.log(`${yellow('■')} ${id} blocked. STOP and ask the human for help.`);
};

commands['add-task'] = (args) => {
  loadConfig();
  const [phaseName, spec] = args;
  if (!phaseName || !spec) fail('Usage: add-task "<Phase heading>" "<title | accept: … | files: … | refs: … | deps: …>"');
  const text = read(F.tasks);
  const tasks = parseTasks(text);
  const nextNum = Math.max(0, ...tasks.map((t) => Number(t.id.slice(1)))) + 1;
  const id = `T${String(nextNum).padStart(2, '0')}`;
  const lines = text.split('\n');
  let h = lines.findIndex((l) => /^##\s/.test(l) && l.replace(/^##\s+/, '').trim().toLowerCase() === phaseName.trim().toLowerCase());
  if (h < 0) { lines.push('', `## ${phaseName}`); h = lines.length - 1; }
  let end = lines.findIndex((l, i) => i > h && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  let at = end;
  while (at > h + 1 && lines[at - 1].trim() === '') at--;
  lines.splice(at, 0, `- [ ] ${id} ${spec.trim()}`);
  write(F.tasks, lines.join('\n'));
  console.log(`${green('✔')} added ${id} to "${phaseName}"`);
};

commands.approve = (args) => {
  loadConfig();
  const [kind, ...rest] = args;
  const name = rest.join(' ').trim();
  if (!['plan', 'phase', 'deploy'].includes(kind)) fail('Usage: approve <plan|phase|deploy> [phase name]');
  if (kind === 'phase' && !name) fail('Usage: approve phase "<phase heading>"');
  const who = git(['config', 'user.name']).out || process.env.USER || process.env.USERNAME || 'human';
  const key = kind === 'phase' ? `phase ${name}` : kind;
  if (isApproved(key)) { console.log(`Already approved: ${key}`); return; }
  appendToSection('Approvals', `- ${key} — approved by ${who} on ${today()}`);
  console.log(`${green('✔')} approved: ${key}`);
  if (kind === 'plan' && existsSync(F.tasks)) {
    // Existing projects: phases already complete when the plan is approved are accepted as the baseline.
    for (const p of phases(parseTasks(read(F.tasks)))) {
      if (p.total && p.done === p.total && !isApproved(`phase ${p.name}`)) {
        appendToSection('Approvals', `- phase ${p.name} — baseline (complete when the plan was approved)`);
        console.log(dim(`  baseline: phase "${p.name}" was already complete`));
      }
    }
  }
};

commands.status = () => {
  const cfg = loadConfig();
  const out = [];
  out.push(`${bold(cfg.project.name)} · ${cfg.stack?.profile ?? 'custom'} · autonomy: ${cfg.autonomy.mode} · deploy: ${cfg.deploy?.target ?? '—'}`);
  if (!existsSync(F.tasks) || !parseTasks(read(F.tasks)).length) {
    out.push('No tasks yet. Next: /engine-start (discovery) then /engine-plan.');
    console.log(out.join('\n'));
    return;
  }
  const tasks = parseTasks(read(F.tasks));
  const doneN = tasks.filter((t) => t.status === 'done').length;
  const bar = '█'.repeat(Math.round((doneN / tasks.length) * 20)).padEnd(20, '░');
  out.push(`Progress: ${doneN}/${tasks.length} ${bar}`);
  for (const p of phases(tasks)) out.push(`  ${p.done === p.total ? green('✔') : '·'} ${p.name}: ${p.done}/${p.total}${isApproved(`phase ${p.name}`) ? dim(' (approved)') : ''}`);
  const active = tasks.find((t) => t.status === 'active');
  const blocked = tasks.filter((t) => t.status === 'blocked');
  const doneSet = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  const next = tasks.find((t) => t.status === 'todo' && t.deps.every((d) => doneSet.has(d)));
  out.push(`Plan approved: ${isApproved('plan') ? green('yes') : yellow('no')}`);
  if (active) out.push(`In progress: ${bold(active.id)} ${active.title} → docs/5_CURRENT_TASK.md`);
  if (blocked.length) out.push(`Blocked: ${blocked.map((t) => `${t.id} ${t.title}`).join('; ')}`);
  if (next && !active) out.push(`Next: ${next.id} ${next.title}`);
  const recent = sectionEntries('Log').slice(-5);
  if (recent.length) out.push('Recent:', ...recent.map((l) => `  ${l}`));
  console.log(out.join('\n'));
};

function compactState(cfg, silent = false) {
  const keep = cfg.context?.stateSummaryKeep ?? 15;
  const lines = stateText().split('\n');
  const b = sectionBounds(lines, 'Log');
  if (!b) return 0;
  const entryIdx = [];
  for (let i = b.start + 1; i < b.end; i++) if (lines[i].startsWith('- ')) entryIdx.push(i);
  if (entryIdx.length <= keep) { if (!silent) console.log('Nothing to compact.'); return 0; }
  const move = entryIdx.slice(0, entryIdx.length - keep);
  const archive = path.join(DOCS, 'archive', 'state-log.md');
  if (!existsSync(archive)) write(archive, '# Archived state log\nOlder entries moved here by `engine compact`. Read only when you need history.\n\n');
  appendFileSync(archive, `${move.map((i) => lines[i]).join('\n')}\n`);
  const set = new Set(move);
  write(F.state, lines.filter((_, i) => !set.has(i)).join('\n'));
  if (!silent) console.log(`${green('✔')} archived ${move.length} entries to docs/archive/state-log.md (kept ${keep}).`);
  return move.length;
}
commands.compact = () => compactState(loadConfig());

commands.doctor = () => {
  const checks = [];
  const add = (ok, label, hint = '') => checks.push(`${ok ? green('✔') : red('✘')} ${label}${!ok && hint ? dim(` — ${hint}`) : ''}`);
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 18, `Node.js ${process.versions.node}`, 'Node 18+ required to run the engine');
  add(isGitRepo(), 'git repository', 'run: git init');
  let cfg;
  try { cfg = loadConfig(); add(true, 'engine.config.jsonc valid'); } catch (e) { add(false, 'engine.config.jsonc', e.message); }
  if (cfg) {
    const seen = new Set();
    for (const g of cfg.commands.gates) {
      const bin = g.run.trim().split(/\s+/)[0];
      if (seen.has(bin)) continue;
      seen.add(bin);
      const found = sh(process.platform === 'win32' ? `where ${bin}` : `command -v ${bin}`).status === 0 || existsSync(path.join(ROOT, bin));
      add(found, `tool available: ${bin}`, `needed by gate(s) using "${bin}"`);
    }
    for (const doc of Object.values(F).filter((p) => p !== F.current)) add(existsSync(doc), rel(doc), `run: ${ENGINE_CMD} init`);
    const gi = existsSync(path.join(ROOT, '.gitignore')) ? read(path.join(ROOT, '.gitignore')).split('\n') : [];
    add(gi.includes('.env'), '.gitignore protects .env', `run: ${ENGINE_CMD} sync`);
    const agents = existsSync(path.join(ROOT, 'AGENTS.md')) ? read(path.join(ROOT, 'AGENTS.md')) : '';
    add(agents === renderTemplate('AGENTS.md', baseContext(cfg)), 'AGENTS.md in sync with config', `run: ${ENGINE_CMD} sync`);
  }
  console.log(checks.join('\n'));
  if (checks.some((l) => l.includes('✘'))) process.exitCode = 1;
};

// ---------------------------------------------------------------- hooks (Claude Code)

function readStdinJson() {
  try { return JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}

commands.hook = (args) => {
  const kind = args[0];
  const input = readStdinJson();
  let cfg;
  try { cfg = loadConfig(); } catch { return; } // engine not initialised: never block
  if (kind === 'pre-edit') {
    const file = input.tool_input?.file_path ?? input.tool_input?.path ?? '';
    const relative = path.isAbsolute(file) ? path.relative(ROOT, file) : file;
    if (file && isSecretPath(relative, cfg.security)) {
      process.stderr.write(`Blocked by engine policy: "${relative}" is a secret file. Put DUMMY values in .env.example and tell the human which real values to set.\n`);
      process.exitCode = 2;
    }
  } else if (kind === 'pre-bash') {
    const cmd = String(input.tool_input?.command ?? '');
    const rules = [
      [/git\s+push\b[^\n]*--force(?!-with-lease)/, 'force-push is not allowed'],
      [/git\s+add\b[^\n]*(^|\s)\.env(\s|$|\.(?!example))/, 'staging .env files is not allowed'],
      [/\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~)(\s|$)/, 'recursive delete of / or ~ is not allowed'],
      [/git\s+(commit|merge)\b[^\n]*--no-verify/, 'skipping git hooks (--no-verify) is not allowed'],
    ];
    const hit = rules.find(([re]) => re.test(cmd));
    if (hit) { process.stderr.write(`Blocked by engine policy: ${hit[1]}.\n`); process.exitCode = 2; }
  } else if (kind === 'stop') {
    if (input.stop_hook_active) return; // already continued once: let the agent stop
    if (!existsSync(F.tasks)) return;
    const active = parseTasks(read(F.tasks)).find((t) => t.status === 'active');
    if (!active) return;
    const { ok, results } = runGates(cfg, { quiet: true });
    const failed = results.filter((r) => !r.ok && r.required).map((r) => r.name);
    process.stderr.write(ok
      ? `Task ${active.id} is still in progress and all gates pass. Finish it: ${ENGINE_CMD} done ${active.id} "<2-sentence summary>"\n`
      : `Task ${active.id} is in progress and gates are failing (${failed.join(', ')}). Run ${ENGINE_CMD} gate, fix the root cause, or ${ENGINE_CMD} block ${active.id} "<reason>".\n`);
    process.exitCode = 2;
  } else {
    fail(`Unknown hook "${kind}"`);
  }
};

// ---------------------------------------------------------------- main

function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const key = args[i].slice(2);
    out[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  }
  return out;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd = 'help', ...args] = process.argv.slice(2);
  const fn = commands[cmd];
  try {
    if (!fn) fail(`Unknown command "${cmd}". Run: ${ENGINE_CMD} help`);
    fn(args);
  } catch (err) {
    if (err instanceof EngineError) { console.error(red(err.message)); process.exitCode ||= 1; }
    else throw err;
  }
}
