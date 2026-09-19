#!/usr/bin/env node
/**
 * Two Playwright call shapes that COMPILE, read as what the author meant, and
 * silently do something else. Both cost this repo a red lane.
 *
 *   waitForFunction(fn, { timeout })     -> the options land in the ARG slot
 *                                           (signature is fn, arg, options), so
 *                                           the call runs at the config's
 *                                           actionTimeout instead. A site
 *                                           asking for 90s got 15s.
 *   isVisible({ timeout }) / isHidden    -> Playwright's own types mark the
 *                                           option `@deprecated This option is
 *                                           ignored`; the check answers
 *                                           instantly. Use isVisibleWithin.
 *
 * Neither is a type error, so nothing else catches them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'e2e/playwright';

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** Split a call's argument list on top-level commas. */
function args(src, openIdx) {
  let i = openIdx, depth = 0;
  for (; i < src.length; i++) {
    if ('([{'.includes(src[i])) depth++;
    else if (')]}'.includes(src[i])) { depth--; if (depth === 0) break; }
  }
  const inner = src.slice(openIdx + 1, i);
  const parts = [];
  let last = 0; depth = 0;
  for (let j = 0; j < inner.length; j++) {
    const ch = inner[j];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) { parts.push(inner.slice(last, j)); last = j + 1; }
  }
  parts.push(inner.slice(last));
  return parts.filter((p) => p.trim());
}

/**
 * The isVisible class is a RATCHET, not a clean gate: 30 inherited sites are
 * harmless-by-accident (their stated timeout equals the config's actionTimeout)
 * and rewriting them blind is the mechanical-sweep mistake that has broken
 * specs here twice. New ones fail; the count may only go down. Lower this
 * number when you fix some, never raise it.
 */
const IS_VISIBLE_BASELINE = 30;

const slotFindings = [];
const isVisibleFindings = [];
for (const file of walk(ROOT)) {
  // The helper that exists to replace the bad call names it in its own docs.
  if (file.endsWith('is-visible-within.ts')) continue;
  const src = readFileSync(file, 'utf8');

  for (const m of src.matchAll(/waitForFunction\(/g)) {
    const open = m.index + m[0].length - 1;
    const parts = args(src, open);
    if (parts.length === 2 && /\btimeout\b/.test(parts[1])) {
      slotFindings.push([file, src.slice(0, m.index).split('\n').length,
        'waitForFunction options are in the ARG slot; pass `undefined` as the second argument']);
    }
  }

  for (const m of src.matchAll(/\.(isVisible|isHidden)\(\s*\{/g)) {
    isVisibleFindings.push([file, src.slice(0, m.index).split('\n').length,
      `${m[1]}() ignores its timeout (Playwright marks it deprecated-and-ignored); use isVisibleWithin`]);
  }
}

let failed = false;

if (slotFindings.length) {
  for (const [file, line, why] of slotFindings) console.error(`${file}:${line}  ${why}`);
  console.error(`\n${slotFindings.length} waitForFunction call(s) with options in the argument slot.`);
  failed = true;
}

if (isVisibleFindings.length > IS_VISIBLE_BASELINE) {
  for (const [file, line, why] of isVisibleFindings) console.error(`${file}:${line}  ${why}`);
  console.error(
    `\n${isVisibleFindings.length} isVisible/isHidden call(s) passing an ignored timeout, ` +
      `up from the ${IS_VISIBLE_BASELINE} inherited. Use isVisibleWithin in new code.`,
  );
  failed = true;
} else if (isVisibleFindings.length < IS_VISIBLE_BASELINE) {
  console.log(
    `isVisible ratchet: ${isVisibleFindings.length} left (baseline ${IS_VISIBLE_BASELINE}). ` +
      'Lower IS_VISIBLE_BASELINE in this script to lock the improvement in.',
  );
}

if (failed) process.exit(1);
console.log(`Playwright argument slots clean (isVisible ratchet at ${isVisibleFindings.length}).`);
