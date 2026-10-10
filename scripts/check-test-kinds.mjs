#!/usr/bin/env node
/**
 * Enforces the family's test contract (`~/Work/ordpool/TESTING.md`) on one repo.
 *
 *   node node_modules/ordpool-sdk/scripts/check-test-kinds.mjs [--report] [root]
 *
 * Default mode prints every finding as `file:line  rule-id  message` and exits 1
 * if there is one. `--report` prints the same plus summary tables and exits 0,
 * which is how a repo measures its migration before the gate is switched on.
 * A malformed `test-kinds.json` exits 1 in both modes.
 *
 * Scope: `test-kinds.json` at the root may list paths owned by an upstream fork
 * (mempool, Leather, ord). Each entry needs a `reason`. Matching files are not
 * checked at all and are listed as skipped in the report. There is no other way
 * to silence a finding: no inline pragma, no allowlist, no baseline.
 *
 *   { "upstream": [ { "glob": "frontend/cypress/**", "reason": "mempool upstream" } ] }
 *
 * Node built-ins only, so a consumer runs it straight from node_modules.
 *
 * The detectors are text heuristics over a lexed copy of each file (comments
 * blanked, and for structural checks string contents blanked too), not an AST.
 * Known limits are stated beside each detector.
 */
import { lstatSync, readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join, relative, sep, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Mainnet and production hosts. A spec or test config naming one outside a
 * captured fixture talks to (or pretends to know) a real system. Root rule:
 * "No test talks to a real system, and regtest is the default".
 */
export const REAL_HOSTS = [
  'api.ordpool.space',
  'ord.ordpool.space',
  'ordpool.space',
  'ordinals.com',
  'mempool.space',
  'blockstream.info',
  'ordinals.unisat.io',
  'node.ord.net',
  'unisat.io',
  'cubes.haushoppe.art',
  'cat21.space',
  'backend2.cat21.space',
  'ord.cat21.space',
  'ordpool-space.github.io',
  'leather.mempool.space',
];

/**
 * SDK wait helpers that take their bound as a positional argument, with the
 * argument's index. A spec passing anything there sets a timeout.
 *
 * Empty: no `ordpool-sdk/e2e` helper takes a timeout. Playwright-side waits
 * run under the runner config's timeouts, and the polling helpers stop at the
 * one global bound (`e2eTimeoutMs`, set by the runner config). The selftest
 * fails on any exported e2e helper with a timeout parameter, so an entry here
 * exists only for a helper that is a defect waiting to be removed.
 */
export const POSITIONAL_TIMEOUT_ARGS = {};

/**
 * The one sanctioned wait for time (`ordpool-sdk/e2e`). Its reason names what
 * is waited for and why there is no state to wait on; a reason shorter than
 * this is `'flaky'` or `'wait a bit'`, which names nothing.
 */
export const WORKAROUND_WAIT = 'workaroundWaitForTimeout';
export const MIN_REASON_LENGTH = 15;

/** Every rule id this checker emits, in report order. */
export const RULE_IDS = [
  'scope-unused',
  'header-missing',
  'header-incomplete',
  'kind-mismatch',
  'kind-location',
  'kind-word',
  'retries',
  'fixed-wait',
  'workaround-without-reason',
  'force-click',
  'swallowed-catch',
  'spec-timeout',
  'optional-wait',
  'real-host',
  'sdk-module-mock',
];

export const KINDS = ['unit', 'db', 'chain', 'wallet', 'e2e'];

/** Words that never name a kind, a suffix or a directory (TESTING.md, "Words that are not test kinds"). */
const NON_KIND_WORDS = ['integration', 'live', 'smoke', 'roundtrip', 'matrix', 'parity', 'mocked'];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.angular', 'coverage']);
const SKIP_DIR_PREFIXES = ['dist-', 'test-results', 'playwright-report'];
/** The checker's own probes. Skipped unless the run is rooted inside them. */
export const SELFTEST_DIR = 'check-test-kinds.selftest';

const SPEC_RE = /\.(spec|test)\.tsx?$|\.vitest\.ts$/;
/** `playwright.config.ts`, `playwright.regtest.config.ts`, `jest.config.node.js`, `vitest.config.mts`; never a `*.setup.*` file. */
const CONFIG_RE = /^(?!.*\.setup\.)(playwright|jest|vitest|cypress)([.-][\w-]+)*\.config(\.[\w-]+)*\.(ts|mts|cts|js|mjs|cjs)$/;

// ---------------------------------------------------------------------------
// Discovery and scope

function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) || name === SELFTEST_DIR || name.startsWith('.')) continue;
        if (SKIP_DIR_PREFIXES.some((p) => name.startsWith(p))) continue;
        visit(full);
      } else if (SPEC_RE.test(name) || CONFIG_RE.test(name)) {
        out.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  visit(root);
  return out;
}

/** `**` spans any number of path segments (zero included), `*` and `?` stay inside one. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Returns `{ entries, errors }`; any error fails the run in every mode. */
function loadScope(root) {
  const file = join(root, 'test-kinds.json');
  if (!existsSync(file)) return { entries: [], errors: [], text: '' };
  const text = readFileSync(file, 'utf8');
  const errors = [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { entries: [], errors: [`test-kinds.json is not valid JSON: ${e.message}`], text };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { entries: [], errors: ['test-kinds.json must be an object'], text };
  }
  for (const key of Object.keys(parsed)) {
    if (key !== 'upstream') errors.push(`test-kinds.json: unknown key "${key}" (only "upstream" exists)`);
  }
  const list = parsed.upstream ?? [];
  if (!Array.isArray(list)) return { entries: [], errors: [...errors, 'test-kinds.json: "upstream" must be an array'], text };
  const entries = [];
  list.forEach((entry, i) => {
    const where = `test-kinds.json: upstream[${i}]`;
    if (typeof entry !== 'object' || entry === null) { errors.push(`${where} must be an object`); return; }
    for (const key of Object.keys(entry)) {
      if (key !== 'glob' && key !== 'reason') errors.push(`${where}: unknown key "${key}"`);
    }
    if (typeof entry.glob !== 'string' || !entry.glob.trim()) errors.push(`${where}: "glob" must be a non-empty string`);
    if (typeof entry.reason !== 'string' || !entry.reason.trim()) errors.push(`${where}: "reason" must be a non-empty string`);
    if (typeof entry.glob === 'string' && entry.glob.trim() && typeof entry.reason === 'string' && entry.reason.trim()) {
      entries.push({ glob: entry.glob, reason: entry.reason, re: globToRegExp(entry.glob), hits: 0 });
    }
  });
  return { entries, errors, text };
}

// ---------------------------------------------------------------------------
// Lexing

const REGEX_PRECEDERS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'await', 'yield', 'void', 'delete', 'throw', 'new']);

/**
 * Two same-length copies of the source, so every offset maps to the same line:
 * `noComments` has comments blanked; `code` additionally blanks the contents of
 * strings, template literal text and regex literals (delimiters kept). Template
 * `${...}` expressions stay code. Newlines are always preserved.
 *
 * Limit: a `/` is a regex start when the previous significant token is an
 * operator, an opening bracket or a keyword such as `return`; a TypeScript
 * generic closing right before a regex literal is misread, which no spec here
 * contains.
 */
export function lex(src) {
  const noC = src.split('');
  const code = src.split('');
  const comments = [];
  const blank = (arr, a, b) => { for (let k = a; k < b; k++) if (arr[k] !== '\n') arr[k] = ' '; };
  const n = src.length;
  let i = 0;
  // Each frame is either 'code' (with brace depth, for template expressions) or 'tmpl'.
  const stack = [{ t: 'code', depth: 0 }];
  let lastSig = ''; // last significant code token text (char or word) for the regex decision

  const readTemplate = () => {
    // at src[i] inside template text; consume until closing backtick or `${`
    const start = i;
    while (i < n) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') { blank(code, start, i); i++; stack.pop(); lastSig = '`'; return; }
      if (src[i] === '$' && src[i + 1] === '{') { blank(code, start, i); i += 2; stack.push({ t: 'code', depth: 0 }); lastSig = '{'; return; }
      i++;
    }
    blank(code, start, n);
  };

  while (i < n) {
    const top = stack[stack.length - 1];
    if (top.t === 'tmpl') { readTemplate(); continue; }
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const s = i;
      while (i < n && src[i] !== '\n') i++;
      comments.push({ start: s, end: i, line: true });
      blank(noC, s, i); blank(code, s, i);
      continue;
    }
    if (c === '/' && d === '*') {
      const s = i;
      const e = src.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
      comments.push({ start: s, end: i, line: false });
      blank(noC, s, i); blank(code, s, i);
      continue;
    }
    if (c === '"' || c === "'") {
      const s = i;
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') i++; i++; }
      blank(code, s + 1, Math.min(i, n));
      i++;
      lastSig = 'str';
      continue;
    }
    if (c === '`') { i++; stack.push({ t: 'tmpl' }); continue; }
    if (c === '/') {
      const isRegex = lastSig === '' || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(lastSig) || REGEX_PRECEDERS.has(lastSig);
      if (isRegex) {
        const s = i;
        i++;
        let inClass = false;
        while (i < n && src[i] !== '\n') {
          if (src[i] === '\\') { i += 2; continue; }
          if (src[i] === '[') inClass = true;
          else if (src[i] === ']') inClass = false;
          else if (src[i] === '/' && !inClass) break;
          i++;
        }
        blank(code, s + 1, Math.min(i, n));
        i++;
        while (i < n && /[a-z]/i.test(src[i])) i++;
        lastSig = 'regex';
        continue;
      }
      lastSig = '/';
      i++;
      continue;
    }
    if (c === '{') { top.depth++; lastSig = '{'; i++; continue; }
    if (c === '}') {
      if (top.depth === 0 && stack.length > 1) { stack.pop(); i++; continue; }
      top.depth--; lastSig = '}'; i++; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const s = i;
      while (i < n && /[\w$]/.test(src[i])) i++;
      lastSig = src.slice(s, i);
      continue;
    }
    if (/\d/.test(c)) { while (i < n && /[\w.]/.test(src[i])) i++; lastSig = 'num'; continue; }
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return { noComments: noC.join(''), code: code.join(''), comments };
}

// ---------------------------------------------------------------------------
// Structural helpers (all operate on the `code` copy, where brackets inside
// strings and comments are already blanked)

const OPEN = '([{';
const CLOSE = ')]}';

/** Index of the bracket matching the opener at `i`, or -1. */
function matchForward(code, i) {
  let depth = 0;
  for (let k = i; k < code.length; k++) {
    if (OPEN.includes(code[k])) depth++;
    else if (CLOSE.includes(code[k])) { depth--; if (depth === 0) return k; }
  }
  return -1;
}

/** Index of the bracket matching the closer at `i`, or -1. */
function matchBackward(code, i) {
  let depth = 0;
  for (let k = i; k >= 0; k--) {
    if (CLOSE.includes(code[k])) depth++;
    else if (OPEN.includes(code[k])) { depth--; if (depth === 0) return k; }
  }
  return -1;
}

/** Split the inside of the call whose `(` is at `open` on top-level commas. */
export function callArgs(code, open) {
  const close = matchForward(code, open);
  if (close === -1) return { args: [], close: -1 };
  const parts = [];
  let depth = 0, last = open + 1;
  for (let k = open + 1; k < close; k++) {
    const ch = code[k];
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) { parts.push({ start: last, end: k }); last = k + 1; }
  }
  parts.push({ start: last, end: close });
  return { args: parts.filter((p) => code.slice(p.start, p.end).trim()), close };
}

function prevNonSpace(code, i) {
  let k = i;
  while (k >= 0 && /\s/.test(code[k])) k--;
  return k;
}

function wordBefore(code, i) {
  let k = prevNonSpace(code, i);
  const end = k + 1;
  while (k >= 0 && /[\w$]/.test(code[k])) k--;
  return code.slice(k + 1, end);
}

/**
 * The opening `(` of the innermost call whose argument list contains `i`, with
 * the callee name. With `stopAtBrace`, an unclosed `{` ends the search: the
 * position is then inside a block, not directly inside a call's arguments.
 */
function enclosingCall(code, i, stopAtBrace = false) {
  let depth = 0;
  for (let k = i - 1; k >= 0; k--) {
    const ch = code[k];
    if (CLOSE.includes(ch)) depth++;
    else if (OPEN.includes(ch)) {
      if (depth > 0) { depth--; continue; }
      if (ch === '{' && stopAtBrace) return null;
      if (ch === '(') {
        const name = wordBefore(code, k - 1);
        const before = prevNonSpace(code, k - 1 - name.length);
        return { open: k, name, isMethod: code[before] === '.' };
      }
    }
  }
  return null;
}

/**
 * What the `{` at `i` opens: `{ kind: 'loop' | 'function' | 'other', callee }`.
 * `callee` is set for a function passed straight to a call (`it('x', async () => {`
 * gives `it`), empty otherwise.
 */
function blockKind(code, i) {
  const p = prevNonSpace(code, i - 1);
  const fn = () => ({ kind: 'function', callee: enclosingCall(code, i, true)?.name ?? '' });
  if (p < 0) return { kind: 'other', callee: '' };
  if (code[p] === '>' && code[p - 1] === '=') return fn();
  if (code[p] === ')') {
    const o = matchBackward(code, p);
    if (o === -1) return { kind: 'other', callee: '' };
    const w = wordBefore(code, o - 1);
    if (w === 'while' || w === 'for') return { kind: 'loop', callee: '' };
    if (['if', 'switch', 'catch', 'with'].includes(w)) return { kind: 'other', callee: '' };
    return fn();
  }
  if (wordBefore(code, i - 1) === 'do') return { kind: 'loop', callee: '' };
  return { kind: 'other', callee: '' };
}

function blockStack(code, i) {
  const stack = [];
  for (let j = 0; j < i; j++) {
    if (code[j] === '{') stack.push(blockKind(code, j));
    else if (code[j] === '}') stack.pop();
  }
  return stack;
}

/** Callees whose function argument runs as the test's own flow. */
const TEST_FLOW = new Set(['it', 'test', 'step', 'describe', 'only', 'skip', 'concurrent', 'failing',
  'beforeAll', 'beforeEach', 'afterAll', 'afterEach', 'evaluate', 'evaluateHandle', '$eval', '$$eval']);

/**
 * True when `i` sits in a function nested inside a test callback that is not
 * itself test flow: a fake's body (`const fetchFn = async () => { await
 * new Promise(r => setTimeout(r, 5)); ... }`) simulating latency, not a wait.
 *
 * Limit: a fake declared at module scope reads as a helper, and its delay is
 * reported.
 */
function inNestedFake(code, i) {
  const fns = blockStack(code, i).filter((b) => b.kind === 'function');
  if (fns.length < 2) return false;
  if (TEST_FLOW.has(fns[fns.length - 1].callee)) return false;
  return fns.slice(0, -1).some((b) => TEST_FLOW.has(b.callee));
}

/**
 * True when `i` sits in a loop body before any function boundary. Covers a
 * braced `while`/`for`/`do` body and a single-statement body
 * (`while (!done()) await new Promise(...)`).
 *
 * Limits: it does not prove the loop is bounded or that it polls a condition;
 * a method with a return-type annotation (`foo(): T {`) inside a loop is not
 * recognised as a function boundary, so a wait inside it reads as in-loop.
 */
function inLoop(code, i) {
  // single-statement body
  let k = prevNonSpace(code, i - 1);
  if (code.slice(k - 4, k + 1) === 'await') k = prevNonSpace(code, k - 5);
  if (code[k] === ')') {
    const o = matchBackward(code, k);
    const w = o === -1 ? '' : wordBefore(code, o - 1);
    if (w === 'while' || w === 'for') return true;
  }
  if (wordBefore(code, k) === 'do') return true;
  // braced bodies
  const stack = blockStack(code, i);
  for (let s = stack.length - 1; s >= 0; s--) {
    if (stack[s].kind === 'loop') return true;
    if (stack[s].kind === 'function') return false;
  }
  return false;
}

/**
 * Start of the member/call chain ending right before `i` (the `.` of `.catch`):
 * `await page.getByTestId('x').click({ timeout: 5 })` -> start of `page`.
 */
function chainStart(code, i) {
  let k = prevNonSpace(code, i - 1);
  let start = i;
  for (;;) {
    if (k < 0) break;
    if (code[k] === ')' || code[k] === ']') {
      const o = matchBackward(code, k);
      if (o === -1) break;
      start = o;
      k = prevNonSpace(code, o - 1);
      continue;
    }
    if (/[\w$]/.test(code[k])) {
      while (k >= 0 && /[\w$]/.test(code[k])) k--;
      start = k + 1;
      const p = prevNonSpace(code, k);
      if (code[p] === '.') { k = prevNonSpace(code, p - 1); if (code[k] === '?') k = prevNonSpace(code, k - 1); continue; }
      break;
    }
    break;
  }
  return start;
}

function isFunctionLike(text) {
  const t = text.trim();
  return /^(async\b|function\b|\(|[\w$]+\s*=>)/.test(t);
}

// ---------------------------------------------------------------------------
// Classification

export function kindFromName(file) {
  const base = file.split('/').pop() ?? file;
  const stem = base.replace(/\.(spec|test)\.tsx?$/, '').replace(/\.vitest\.ts$/, '');
  const last = stem.split('.').slice(1).pop();
  return last && KINDS.includes(last) && last !== 'unit' ? last : 'unit';
}

const FAKE_PATTERNS = [
  /\bjest\.(mock|doMock|unstable_mockModule|spyOn|fn|useFakeTimers|replaceProperty)\s*\(/,
  /\bvi\.(mock|doMock|spyOn|fn|stubGlobal|stubEnv|useFakeTimers)\s*\(/,
  /(?<![\w$.])spyOn\s*\(/,
  /\.(route|routeFromHAR|routeWebSocket)\s*\(/,
  /\b(globalThis|global|window)\.fetch\s*=(?!=)/,
  /\bHttpTestingController\b/,
  /(?<![\w$.])nock\s*\(/,
];

function parseHeader(src, lexed) {
  const firstCode = lexed.code.search(/\S/);
  const c0 = lexed.comments[0];
  if (!c0 || (firstCode !== -1 && c0.start > firstCode)) return null;
  let end = c0.end;
  if (c0.line) {
    // a run of `//` lines separated only by single newlines is one block
    for (let k = 1; k < lexed.comments.length; k++) {
      const c = lexed.comments[k];
      if (!c.line || !/^[ \t]*\r?\n[ \t]*$/.test(src.slice(end, c.start))) break;
      end = c.end;
    }
  }
  return { start: c0.start, text: src.slice(c0.start, end) };
}

/**
 * A header field's value: everything after `Name:` up to the next field or the
 * end of the comment, so a value may continue on the following lines.
 */
function headerField(text, name) {
  const m = new RegExp(`^[\\s*/]*${name}:`, 'm').exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = rest.search(/^[\s*/]*(Real|Faked|Proves):|@test-kind\b/m);
  return (next === -1 ? rest : rest.slice(0, next)).replace(/\*\/\s*$/, '').replace(/^[ \t]*(\*|\/\/)/gm, '').trim();
}

// ---------------------------------------------------------------------------
// Detectors

function lineOf(lineStarts, idx) {
  let lo = 0, hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= idx) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * A production host as an ADDRESS: behind a scheme (`https://`, `http://`, `wss://`, `ws://`),
 * optionally under a subdomain. The bare name as data (an inscription body that carries
 * `<!--cubes.haushoppe.art-->`, a `minted_by: 'ordpool.space'` field) reaches nothing and is
 * not reported.
 */
const HOST_RE = new RegExp(
  `(?:https?|wss?)://((?:[\\w-]+\\.)*(?:${[...REAL_HOSTS].sort((a, b) => b.length - a.length).map((h) => h.replace(/\./g, '\\.')).join('|')}))(?![\\w-])`,
  'gi',
);

export function checkFile(file, src) {
  const findings = [];
  /** Lines of `workaroundWaitForTimeout` calls; every one is a defect report against the app or wallet. */
  const workarounds = [];
  /** Timeout keys a runner config sets, `line key: value`; listed in the report, not gated. */
  const configTimeouts = [];
  const lexed = lex(src);
  const { code, noComments } = lexed;
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);
  const add = (idx, rule, message) => findings.push({ file, line: lineOf(lineStarts, idx), rule, message });
  const base = file.split('/').pop() ?? file;
  const isConfig = CONFIG_RE.test(base) && !SPEC_RE.test(base);
  const isFixturePath = ('/' + file).includes('/fixtures/') || file.endsWith('.fixtures.ts');

  // real-host: specs and test configs, outside comments and test titles, except captured fixtures.
  // A title (`test('mint via cat21.space ...', ...)`) names the site; it does not reach it.
  if (!isFixturePath) {
    const titles = [];
    for (const m of code.matchAll(/(?<![\w$.])(?:it|test|describe)(?:\.[\w$]+)*\s*\(|\.step\s*\(/g)) {
      const { args } = callArgs(code, m.index + m[0].length - 1);
      const first = args[0];
      if (first && /^\s*['"`]/.test(code.slice(first.start, first.end))) titles.push(first);
    }
    // In a unit spec a production URL is often the subject (a function that rewrites
    // ordinals.com links); only a URL handed to a request is a real system being reached.
    // Every other kind and every runner config reaches what it names.
    // Limit: a unit spec that keeps a production URL in a variable and requests it later
    // is not seen; the strict form applies once the file carries its real kind suffix.
    const unitOnlyRequests = !isConfig && kindFromName(file) === 'unit';
    const REQUEST_CALLS = new Set(['fetch', 'get', 'post', 'put', 'request', 'goto', 'newPage', 'connect', 'WebSocket', 'EventSource']);
    for (const m of noComments.matchAll(HOST_RE)) {
      if (titles.some((t) => m.index >= t.start && m.index < t.end)) continue;
      if (unitOnlyRequests) {
        const call = enclosingCall(code, m.index);
        if (!call || !REQUEST_CALLS.has(call.name)) continue;
      }
      add(m.index, 'real-host', `reaches production host ${m[1]}; use regtest or a captured fixture`);
    }
  }

  // retries
  const retryValue = (at) => {
    const vStart = at;
    if (code[code.slice(vStart).search(/\S/) + vStart] === '{') return '{...}';
    let depth = 0, k = vStart;
    for (; k < code.length; k++) {
      const ch = code[k];
      if (OPEN.includes(ch)) depth++;
      else if (CLOSE.includes(ch)) { if (depth === 0) break; depth--; }
      else if ((ch === ',' || ch === ';' || ch === '\n') && depth === 0) break;
    }
    return noComments.slice(vStart, k).trim();
  };
  const checkRetriesIn = (from, to) => {
    const slice = code.slice(from, to);
    for (const m of slice.matchAll(/(?<![\w$.])retries\s*[:=](?!=)\s*/g)) {
      const v = retryValue(from + m.index + m[0].length);
      if (v !== '0' && v !== 'number') add(from + m.index, 'retries', `retries set to \`${v}\`; the only allowed value is 0`);
    }
  };
  if (isConfig) {
    checkRetriesIn(0, code.length);
    for (const m of code.matchAll(/(?<![\w$.])([\w$]*[tT]imeout(?:Ms)?)\s*:(?!:)/g)) {
      const before = code[prevNonSpace(code, m.index - 1)];
      if (before === '{' || before === ',') configTimeouts.push(`${lineOf(lineStarts, m.index)} ${m[1]}: ${retryValue(m.index + m[0].length)}`);
    }
    return { findings, workarounds, configTimeouts };
  }
  for (const m of code.matchAll(/\.(configure|use)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchForward(code, open);
    if (close !== -1) checkRetriesIn(open, close);
  }
  for (const m of code.matchAll(/\b(jest\.retryTimes|this\.retries)\s*\(/g)) {
    add(m.index, 'retries', `${m[1]}() retries a failing test`);
  }

  // header rules
  const kind = kindFromName(file);
  const header = parseHeader(src, lexed);
  const kindTagAnywhere = /@test-kind\b/.test(src);
  const headerKind = header ? /@test-kind[ \t]+([\w-]+)/.exec(header.text) : null;
  const fakes = FAKE_PATTERNS.some((re) => re.test(code));
  if (!headerKind && (kind !== 'unit' || fakes)) {
    const why = kind !== 'unit' ? `a ${kind} spec` : 'a unit spec that fakes something';
    const where = kindTagAnywhere ? ' (@test-kind is present but not in the first comment block before any code)' : '';
    add(0, 'header-missing', `${why} needs a @test-kind header${where}`);
  }
  if (headerKind && header) {
    const missing = ['Real', 'Faked', 'Proves'].filter((f) => !headerField(header.text, f));
    if (missing.length) add(header.start, 'header-incomplete', `header lacks a non-empty ${missing.map((f) => f + ':').join(', ')} line`);
    const declared = headerKind[1];
    if (declared !== kind) {
      const what = KINDS.includes(declared) ? `@test-kind ${declared}` : `@test-kind ${declared} (not one of ${KINDS.join(', ')})`;
      add(header.start + header.text.indexOf('@test-kind'), 'kind-mismatch', `${what} disagrees with the file name, which makes it ${kind}`);
    }
  }

  // A unit spec never drives a browser; a Playwright import makes it wallet or e2e.
  const playwright = /\bfrom\s+['"](@playwright\/test|playwright|playwright-core)['"]|\brequire\(\s*['"](@playwright\/test|playwright|playwright-core)['"]\s*\)/.exec(noComments);
  // A header already disagreeing with the name reports the same cause; one finding is enough.
  const headerDisagrees = headerKind !== null && headerKind[1] !== kind;
  if (kind === 'unit' && playwright && !headerDisagrees) {
    add(playwright.index, 'kind-mismatch', `imports ${playwright[1] ?? playwright[2]}, so it is not unit; name it .wallet.spec.ts or .e2e.spec.ts`);
  }

  // kind-location
  const dirs = file.split('/').slice(0, -1);
  const under = (a, b) => dirs.some((d, k) => d === a && (b === undefined || dirs[k + 1] === b));
  if (kind === 'chain' && !under('e2e', 'chain')) add(0, 'kind-location', 'a chain spec lives under e2e/chain/');
  if (kind === 'wallet' && !under('e2e', 'wallet')) add(0, 'kind-location', 'a wallet spec lives under e2e/wallet/');
  if (kind === 'e2e' && !under('e2e')) add(0, 'kind-location', 'an e2e spec lives under e2e/');
  if (kind === 'unit' && !playwright && under('e2e') && !/\.(unit|node|browser)\.(spec|test)\.tsx?$/.test(base)) {
    add(0, 'kind-location', 'a spec under e2e/ is named for its kind (.chain/.wallet/.e2e.spec.ts); a unit spec of e2e helper code says .unit.spec.ts');
  }

  // kind-word: a non-kind word as a directory or as a dot-segment of the suffix
  for (const d of dirs) {
    if (NON_KIND_WORDS.includes(d.toLowerCase())) add(0, 'kind-word', `directory "${d}" uses a word that is not a test kind`);
  }
  const segs = base.replace(/\.(spec|test)\.tsx?$|\.vitest\.ts$/, '').split('.').slice(1);
  for (const s of segs) {
    if (NON_KIND_WORDS.includes(s.toLowerCase())) add(0, 'kind-word', `suffix segment ".${s}" uses a word that is not a test kind`);
  }

  // fixed-wait
  for (const m of code.matchAll(/\bwaitForTimeout\s*\(/g)) add(m.index, 'fixed-wait', 'waitForTimeout is a fixed wait; wait for a state');
  for (const m of code.matchAll(/\bawait\s+new\s+Promise\s*(<[^>(]*>)?\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchForward(code, open);
    if (close === -1) continue;
    const body = code.slice(open + 1, close);
    const pm = /^\s*(?:\(\s*([\w$]+)[^)]*\)|([\w$]+))\s*=>/.exec(body);
    const r = pm ? (pm[1] ?? pm[2]) : null;
    if (!r) continue;
    const resolverTimer = new RegExp(`setTimeout\\s*\\(\\s*(${r}\\s*,|\\(\\s*\\)\\s*=>\\s*\\{?\\s*${r}\\s*\\()`);
    if (resolverTimer.test(body) && !inLoop(code, m.index) && !inNestedFake(code, m.index)) {
      add(m.index, 'fixed-wait', 'awaiting a setTimeout outside a poll loop is a fixed wait');
    }
  }
  for (const m of code.matchAll(/\bawait\s+(setTimeout|scheduler\.wait)\s*\(/g)) {
    if (!inLoop(code, m.index) && !inNestedFake(code, m.index)) add(m.index, 'fixed-wait', `await ${m[1]}() outside a poll loop is a fixed wait`);
  }
  // An awaited helper call. Without `await` the call waits for nothing (an RxJS
  // `delay(100)` operator under test is not a wait).
  for (const m of code.matchAll(/\bawait\s+(sleep|delay|wait|pause)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchForward(code, open);
    if (close === -1) continue;
    const after = code.slice(close + 1).match(/^\s*(\S)/);
    if (after !== null && (after[1] === '{' || after[1] === ':')) continue;
    const first = noComments.slice(open + 1, close).trim();
    if ((m[1] === 'wait' || m[1] === 'pause') && !/^[\d_]+(\s*[*]\s*[\d_]+)*$/.test(first.split(',')[0].trim())) continue;
    if (!inLoop(code, m.index) && !inNestedFake(code, m.index)) add(m.index, 'fixed-wait', `${m[1]}() outside a poll loop is a fixed wait`);
  }

  // workaroundWaitForTimeout(page, ms, reason): the sanctioned wait for time, counted, reason required
  for (const m of code.matchAll(new RegExp(`(?<![\\w$])${WORKAROUND_WAIT}\\s*\\(`, 'g'))) {
    if (/\bfunction\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue;
    workarounds.push(lineOf(lineStarts, m.index));
    const { args } = callArgs(code, m.index + m[0].length - 1);
    const reason = args[2] ? noComments.slice(args[2].start, args[2].end).trim() : '';
    const literal = /^(['"])(.*)\1$/s.exec(reason) ?? /^`([^`$]*)`$/s.exec(reason);
    const text = literal ? (literal[2] ?? literal[1]).trim() : '';
    if (text.length < MIN_REASON_LENGTH) {
      add(m.index, 'workaround-without-reason', `${WORKAROUND_WAIT}() needs a string-literal reason of at least ${MIN_REASON_LENGTH} characters naming what is waited for and why it has no state`);
    }
  }

  // force-click
  const FORCE_ACTIONS = new Set(['click', 'dblclick', 'tap', 'check', 'uncheck', 'setChecked', 'fill', 'hover', 'selectOption', 'selectText', 'dragTo']);
  for (const m of code.matchAll(/\bforce\s*:\s*true\b/g)) {
    const call = enclosingCall(code, m.index);
    if (call && call.isMethod && FORCE_ACTIONS.has(call.name)) add(m.index, 'force-click', `force: true on .${call.name}() skips the actionability checks`);
  }
  for (const m of code.matchAll(/(?<![\w$])(evaluate|evaluateHandle|\$eval|\$\$eval|evaluateAll)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchForward(code, open);
    if (close === -1) continue;
    const inner = noComments.slice(open, close);
    for (const c of inner.matchAll(/\.click\s*\(/g)) add(open + c.index, 'force-click', `a click dispatched through ${m[1]}() bypasses the user path`);
  }

  // swallowed-catch
  /** Swallowed `.catch` / `catch` sites with the guarded text, reused by optional-wait. */
  const swallowSites = [];
  const GUARDED = /\.(click|dblclick|tap|check|uncheck|fill|isVisible|isHidden)\s*\(|(?<![\w$])(expect(\.\w+)?|waitFor\w*)\s*\(|\.waitFor\w*\s*\(/;
  for (const m of code.matchAll(/\.catch\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchForward(code, open);
    if (close === -1) continue;
    const receiver = code.slice(chainStart(code, m.index), m.index);
    const handler = code.slice(open + 1, close);
    // `.catch((e) => e)` captures the error for an assertion; it does not swallow it.
    const captures = /^\s*(?:\(\s*([\w$]+)\s*(?::[^)]*)?\)|([\w$]+))\s*=>\s*([\w$]+)\s*$/.exec(handler);
    const isCapture = captures !== null && (captures[1] ?? captures[2]) === captures[3];
    if (!isCapture && !/\bthrow\b/.test(handler)) swallowSites.push({ at: m.index, guarded: receiver });
    if (GUARDED.test(receiver) && !isCapture && !/\bthrow\b/.test(handler)) {
      add(m.index, 'swallowed-catch', '.catch() without a rethrow on a click, wait or assertion swallows its failure');
    }
  }
  for (const m of code.matchAll(/\btry\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchForward(code, open);
    if (close === -1) continue;
    const cm = /^\s*catch\s*(\([^)]*\))?\s*\{/.exec(code.slice(close + 1));
    if (!cm) continue;
    const cOpen = close + 1 + cm[0].length - 1;
    const cClose = matchForward(code, cOpen);
    if (cClose === -1) continue;
    const catchAt = close + 1 + cm[0].indexOf('catch');
    if (!/\bthrow\b/.test(code.slice(cOpen, cClose))) swallowSites.push({ at: catchAt, guarded: code.slice(open, close) });
    if (GUARDED.test(code.slice(open, close)) && !/\bthrow\b/.test(code.slice(cOpen, cClose))) {
      add(close + 1 + cm[0].indexOf('catch'), 'swallowed-catch', 'catch without a rethrow around a click, wait or assertion swallows its failure');
    }
  }

  // spec-timeout: any timeout in a spec, literal or named. Only a runner config sets one.
  for (const m of code.matchAll(/\b(test\.setTimeout|jest\.setTimeout|test\.slow|vi\.setConfig)\s*\(/g)) {
    add(m.index, 'spec-timeout', `${m[1]} in a spec; the runner config holds the one timeout`);
  }
  // An object key such as `timeout`, `timeoutMs`, `popupTimeoutMs`, `actionTimeout`,
  // in key position (after `{` or `,`). A TypeScript type member (`timeout: number`) is not a value.
  for (const m of code.matchAll(/(?<![\w$.])([\w$]*[tT]imeout(?:Ms)?)\s*:(?!:)/g)) {
    const before = code[prevNonSpace(code, m.index - 1)];
    if (before !== '{' && before !== ',') continue;
    const value = code.slice(m.index + m[0].length).match(/^\s*([\w$]+)\s*[;,}\n]/);
    if (value && ['number', 'string', 'boolean', 'undefined', 'unknown'].includes(value[1])) continue;
    add(m.index, 'spec-timeout', `\`${m[1]}:\` sets a timeout in a spec; the runner config holds the one timeout`);
  }
  for (const [helper, index] of Object.entries(POSITIONAL_TIMEOUT_ARGS)) {
    for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${helper}\\s*\\(`, 'g'))) {
      if (/\bfunction\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue;
      const { args } = callArgs(code, m.index + m[0].length - 1);
      const arg = args[index];
      if (arg) add(arg.start + code.slice(arg.start, arg.end).search(/\S/), 'spec-timeout', `timeout argument to ${helper}(); the runner config holds the one timeout`);
    }
  }
  for (const m of code.matchAll(/(?<![\w$.])(it|test)(?:\.(only|skip|concurrent|failing))?\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const { args } = callArgs(code, open);
    if (args.length >= 3 && !isFunctionLike(code.slice(args[args.length - 1].start, args[args.length - 1].end))) {
      add(args[args.length - 1].start, 'spec-timeout', `per-test timeout argument on ${m[1]}(); the runner config holds the one timeout`);
    }
  }
  for (const m of code.matchAll(/(?<![\w$])(beforeAll|beforeEach|afterAll|afterEach)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const { args } = callArgs(code, open);
    if (args.length >= 2 && !isFunctionLike(code.slice(args[args.length - 1].start, args[args.length - 1].end))) {
      add(args[args.length - 1].start, 'spec-timeout', `timeout argument on ${m[1]}(); the runner config holds the one timeout`);
    }
  }

  // optional-wait: a wait that hopes nothing happens. Race the event against the
  // state that means it is not coming instead.
  for (const m of code.matchAll(/(?<![\w$.])(waitForOptionalApprovalPopup|isVisibleWithin)\s*\(/g)) {
    if (/\bfunction\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue;
    add(m.index, 'optional-wait', `${m[1]}() waits for something that may not come; race it against the state that means it is not coming`);
  }
  const HOPED = /(?<![\w$])(waitForApprovalPopup|waitFor\w*Popup\w*)\s*\(|(?<![\w$])waitFor\s*\(|\.waitFor\s*\(/;
  for (const site of swallowSites) {
    if (HOPED.test(site.guarded)) add(site.at, 'optional-wait', 'a wait whose failure is swallowed hopes nothing happens; race it against the state that means it is not coming');
  }

  // sdk-module-mock
  for (const m of noComments.matchAll(/\b(jest|vi)\.(mock|doMock|unstable_mockModule)\s*\(\s*(['"`])(ordpool-sdk(?:\/[^'"`]*)?)\3/g)) {
    const open = m.index + m[0].indexOf('(');
    const { args } = callArgs(code, open);
    const factory = args[1] ? noComments.slice(args[1].start, args[1].end) : '';
    const spec = m[4].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const actual = new RegExp(`(requireActual|importActual)\\s*(<[^>(]*(\\([^)]*\\))?[^>(]*>)?\\s*\\(\\s*['"\`]${spec}['"\`]\\s*\\)|\\bimportOriginal\\s*(<[^>(]*(\\([^)]*\\))?[^>(]*>)?\\s*\\(`);
    if (!actual.test(factory)) {
      add(m.index, 'sdk-module-mock', `${m[1]}.${m[2]}('${m[4]}') replaces the SDK module; spread ${m[1] === 'vi' ? 'vi.importActual' : 'jest.requireActual'}('${m[4]}') and override only its IO`);
    }
  }

  return { findings, workarounds, configTimeouts };
}

// ---------------------------------------------------------------------------
// Run

export function run(root) {
  const scope = loadScope(root);
  if (scope.errors.length) return { errors: scope.errors };
  const files = walk(root);
  const findings = [];
  const skipped = [];
  const perKind = Object.fromEntries(KINDS.map((k) => [k, { files: 0, withFindings: 0, findings: 0 }]));
  let configs = 0;
  const workarounds = [];
  const configTimeouts = [];
  for (const file of files) {
    const entry = scope.entries.find((e) => e.re.test(file));
    if (entry) { entry.hits++; skipped.push({ file, reason: entry.reason }); continue; }
    const checked = checkFile(file, readFileSync(join(root, file), 'utf8'));
    const fs = checked.findings;
    findings.push(...fs);
    for (const line of checked.workarounds) workarounds.push(`${file}:${line}`);
    for (const t of checked.configTimeouts) {
      const sp = t.indexOf(' ');
      configTimeouts.push(`${file}:${t.slice(0, sp)}  ${t.slice(sp + 1)}`);
    }
    const base = file.split('/').pop() ?? file;
    if (CONFIG_RE.test(base) && !SPEC_RE.test(base)) { configs++; continue; }
    const k = perKind[kindFromName(file)];
    k.files++;
    k.findings += fs.length;
    if (fs.length) k.withFindings++;
  }
  const lines = scope.text.split('\n');
  for (const e of scope.entries) {
    if (e.hits === 0) {
      const at = lines.findIndex((l) => l.includes(JSON.stringify(e.glob)));
      findings.push({ file: 'test-kinds.json', line: at + 1 || 1, rule: 'scope-unused', message: `upstream glob ${JSON.stringify(e.glob)} matches no test file` });
    }
  }
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)));
  workarounds.sort();
  return { findings, skipped, perKind, configs, workarounds, configTimeouts, errors: [] };
}

function pad(s, n) { return String(s).padEnd(n); }

function main(argv) {
  const report = argv.includes('--report');
  const rest = argv.filter((a) => a !== '--report');
  if (rest.some((a) => a.startsWith('-'))) {
    console.error('usage: check-test-kinds.mjs [--report] [root]');
    return 2;
  }
  const root = resolve(rest[0] ?? '.');
  const result = run(root);
  if (result.errors.length) {
    for (const e of result.errors) console.error(e);
    return 1;
  }
  const { findings, skipped, perKind, configs, workarounds, configTimeouts } = result;
  for (const f of findings) console.log(`${f.file}:${f.line}  ${f.rule}  ${f.message}`);
  if (report) {
    console.log('');
    console.log(`Test kinds report for ${root}`);
    console.log('');
    const W = Math.max(...RULE_IDS.map((r) => r.length)) + 2;
    console.log(`${pad('rule', W)}${pad('findings', 10)}files`);
    for (const r of RULE_IDS) {
      const hits = findings.filter((f) => f.rule === r);
      console.log(`${pad(r, W)}${pad(hits.length, 10)}${new Set(hits.map((f) => f.file)).size}`);
    }
    console.log(`${pad('total', W)}${pad(findings.length, 10)}${new Set(findings.map((f) => f.file)).size}`);
    console.log('');
    console.log(`${pad('kind', 10)}${pad('files', 8)}${pad('with findings', 15)}findings`);
    for (const k of KINDS) console.log(`${pad(k, 10)}${pad(perKind[k].files, 8)}${pad(perKind[k].withFindings, 15)}${perKind[k].findings}`);
    console.log(`${pad('configs', 10)}${configs}`);
    console.log('');
    const unreasoned = findings.filter((f) => f.rule === 'workaround-without-reason').length;
    console.log(`sanctioned workarounds (${WORKAROUND_WAIT}): ${workarounds.length} (${unreasoned} without a valid reason)`);
    for (const w of workarounds) console.log(`  ${w}`);
    console.log('');
    console.log(`timeouts set in runner configs (the contract wants one global value per config): ${configTimeouts.length}`);
    for (const t of configTimeouts) console.log(`  ${t}`);
    console.log('');
    if (skipped.length) {
      const byReason = new Map();
      for (const s of skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
      console.log(`upstream, skipped: ${skipped.length} file(s)`);
      for (const [reason, count] of [...byReason].sort()) console.log(`  ${count}  (${reason})`);
      for (const s of skipped) console.log(`  ${s.file}  upstream, skipped (${s.reason})`);
    } else {
      console.log('upstream, skipped: none');
    }
    return 0;
  }
  if (findings.length) {
    console.error(`\n${findings.length} test-contract finding(s). See ~/Work/ordpool/TESTING.md.`);
    return 1;
  }
  console.log('Test contract clean.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  process.exitCode = main(process.argv.slice(2));
}
