// mend: the CLI SPEC.md specifies (MIT). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Sections 1 to 4, 9 and 10 of SPEC.md (command line, output, safe paths, format
// detection, JSON edits, all-or-nothing write) follow the kit starter; sections
// 5 to 8 (three-tier line matching, unified diffs, SEARCH/REPLACE blocks and
// V4A patches) are implemented here. The last lines hand a trial over to
// runner.ts when MAKEFUN_ENV_URL is set: keep them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Split a file's text into its lines, its line break and whether it ends with one. */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const leadingWS = (s: string): string => s.match(/^[ \t]*/)?.[0] ?? '';
const rtrimWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---- section 5: matching lines ---- */

function tierMatch(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWS(a) === rtrimWS(b);
  return trimWS(a) === trimWS(b);
}

/** All 0-based positions where O occurs in file lines at the tier, at or after minPos. */
function findOccurrences(fileLines: string[], o: string[], tier: number, minPos = 0): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, minPos); i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!tierMatch(fileLines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once at or after minPos, with its occurrences. */
function findFirstTier(
  fileLines: string[],
  o: string[],
  strict: boolean,
  minPos = 0,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(fileLines, o, t, minPos);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * Replace O (found at pos) with N. ctxMap maps an index of N that is a context
 * line to the index of the O line it is; context lines are written as the
 * file's own matched line, and at tier 2 the other lines of N are re-indented.
 */
function applyReplace(
  fileLines: string[],
  o: string[],
  n: string[],
  pos: number,
  tier: number,
  ctxMap: Map<number, number>,
): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadingWS(fileLines[pos]!);
    p = leadingWS(o[0]!);
  }
  const out: string[] = [];
  for (let j = 0; j < n.length; j++) {
    const oi = ctxMap.get(j);
    if (oi !== undefined) {
      out.push(fileLines[pos + oi]!);
      continue;
    }
    const line = n[j]!;
    if (tier === 2 && line.trim() !== '' && line.startsWith(p)) out.push(f + line.slice(p.length));
    else out.push(line);
  }
  return [...fileLines.slice(0, pos), ...out, ...fileLines.slice(pos + o.length)];
}

/** Old lines O and new lines N from a hunk/chunk body, with the context map. */
function buildON(body: string[]): { o: string[]; n: string[]; ctxMap: Map<number, number> } {
  const o: string[] = [];
  const n: string[] = [];
  const ctxMap = new Map<number, number>();
  for (const raw of body) {
    if (raw.startsWith('\\')) continue;
    if (raw === '' || raw.startsWith(' ')) {
      const text = raw === '' ? '' : raw.slice(1);
      ctxMap.set(n.length, o.length);
      o.push(text);
      n.push(text);
    } else if (raw.startsWith('-')) o.push(raw.slice(1));
    else if (raw.startsWith('+')) n.push(raw.slice(1));
  }
  return { o, n, ctxMap };
}

/** True when a `\` line follows the body's last context or `+` line. */
function noFinalBreak(body: string[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    const r = body[i]!;
    if (r === '' || r.startsWith(' ') || r.startsWith('+')) last = i;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.startsWith('\\');
}

/* ---- section 9: JSON edits (kit starter) ---- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- section 6: unified diffs ---- */

interface Hunk {
  a: number;
  body: string[];
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  pairSeen: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path after `--- `/`+++ `: text after four chars, up to the first tab, trimmed, a/ or b/ removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  const sections: Section[] = [];
  let cur: Section | null = null;
  let curHunk: Hunk | null = null;
  const closeBody = (): void => {
    if (curHunk !== null) {
      while (curHunk.body.length > 0) {
        const last = curHunk.body[curHunk.body.length - 1]!;
        if (last === '' || last === ' ') curHunk.body.pop();
        else break;
      }
      curHunk = null;
    }
  };
  const pushSection = (): void => {
    closeBody();
    if (cur !== null) sections.push(cur);
    cur = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (curHunk !== null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        closeBody();
        continue;
      }
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        curHunk.body.push(line);
        i++;
        continue;
      }
      closeBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      pushSection();
      cur = { oldPath: m[1]!, newPath: m[2]!, pairSeen: false, newFile: false, deletedFile: false, hunks: [] };
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hunks.length > 0) {
        pushSection();
        cur = { oldPath: null, newPath: null, pairSeen: false, newFile: false, deletedFile: false, hunks: [] };
      }
      cur.oldPath = headerPath(lines[i]!);
      cur.newPath = headerPath(lines[i + 1]!);
      if (cur.oldPath === '/dev/null') cur.oldPath = null;
      if (cur.newPath === '/dev/null') cur.newPath = null;
      cur.pairSeen = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a: parseInt(m[1]!, 10), body: [] };
      cur.hunks.push(curHunk);
      i++;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ') && !cur.pairSeen) cur.oldPath = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ') && !cur.pairSeen) cur.newPath = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  pushSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Apply a section's hunks in order to a file's text; errPath is the file the hunks read. */
function applyHunks(content: string, hunks: Hunk[], strict: boolean, errPath: string): string {
  let { lines, br, final } = splitFile(content);
  let d = 0;
  for (const h of hunks) {
    const { o, n, ctxMap } = buildON(h.body);
    const noFinal = noFinalBreak(h.body);
    if (o.length > 0) {
      const found = findFirstTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', errPath);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const reachedEnd = best + o.length === lines.length;
      lines = applyReplace(lines, o, n, best, found.tier, ctxMap);
      if (reachedEnd) final = !noFinal;
      d += n.length - o.length;
    } else {
      const insertAt = Math.min(h.a + d, lines.length);
      const atEnd = insertAt === lines.length;
      lines = [...lines.slice(0, insertAt), ...n, ...lines.slice(insertAt)];
      if (atEnd) final = !noFinal;
      d += n.length;
    }
  }
  return joinFile(lines, br, final);
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = oldP === null || sec.newFile;
    const isDelete = newP === null || sec.deletedFile;
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plusLines: string[] = [];
      for (const h of sec.hunks) {
        for (const r of h.body) if (r.startsWith('+')) plusLines.push(r.slice(1));
      }
      let noFinal = false;
      let lastPlus: { hunk: Hunk; idx: number } | null = null;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k]!.startsWith('+')) lastPlus = { hunk: h, idx: k };
        }
      }
      if (lastPlus !== null) {
        const next = lastPlus.hunk.body[lastPlus.idx + 1];
        noFinal = next !== undefined && next.startsWith('\\');
      }
      const content = plusLines.length === 0 ? '' : plusLines.join('\n') + (noFinal ? '' : '\n');
      tree.now.set(p, content);
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const content = applyHunks(text, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, content);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(text, sec.hunks, strict, p));
  };
}

/* ---- section 7: SEARCH/REPLACE blocks ---- */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
      if (l.trimEnd() === '>>>>>>> REPLACE') break;
      if (l.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trimEnd() === '<<<<<<< SEARCH') break;
      if (l.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const { lines, br, final } = splitFile(text);
    const found = findFirstTier(lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    tree.now.set(path, joinFile(applyReplace(lines, oldLines, newLines, found.occ[0]!, found.tier, new Map()), br, final));
  };
}

/* ---- section 8: V4A patches ---- */

interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  content: { text: string; num: number }[];
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  const flush = (): void => {
    if (cur !== null) sections.push(cur);
    cur = null;
  };
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ')) {
      flush();
      const kind = line.startsWith('*** Add') ? 'add' : line.startsWith('*** Delete') ? 'delete' : 'update';
      const prefix = kind === 'add' ? '*** Add File: ' : kind === 'delete' ? '*** Delete File: ' : '*** Update File: ';
      cur = { kind, path: line.slice(prefix.length).trim(), line: i + 1, content: [] };
    } else if (cur === null) {
      if (!blank(line)) throw new Exit2(`error: parse ${i + 1}`);
    } else {
      cur.content.push({ text: line, num: i + 1 });
    }
  }
  flush();
  for (const s of sections) {
    while (s.content.length > 0 && blank(s.content[s.content.length - 1]!.text)) s.content.pop();
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => vSectionEdit(s, strict));
}

function vSectionEdit(s: VSection, strict: boolean): Edit {
  if (s.kind === 'add') {
    const fileLines: string[] = [];
    for (const c of s.content) {
      if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
      else if (c.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${c.num}`);
    }
    const path = s.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    for (const c of s.content) throw new Exit2(`error: parse ${c.num}`);
    const path = s.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  // update
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let curChunk: VChunk | null = null;
  for (let idx = 0; idx < s.content.length; idx++) {
    const c = s.content[idx]!;
    const line = c.text;
    if (idx === 0 && line.startsWith('*** Move to: ')) {
      moveTo = line.slice('*** Move to: '.length).trim();
      continue;
    }
    if (line.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${c.num}`);
    if (line === '*** End of File') {
      if (curChunk === null) throw new Exit2(`error: parse ${c.num}`);
      curChunk.eof = true;
      curChunk = null;
      continue;
    }
    if (line.startsWith('@@')) {
      curChunk = { anchor: line.slice(2).trim(), body: [], eof: false };
      chunks.push(curChunk);
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line === '') {
      if (curChunk === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${c.num}`);
        curChunk = { anchor: null, body: [], eof: false };
        chunks.push(curChunk);
      }
      curChunk.body.push(line);
      continue;
    }
    throw new Exit2(`error: parse ${c.num}`);
  }
  if (moveTo === null && chunks.length === 0) throw new Exit2(`error: parse ${s.line}`);
  const path = s.path;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let { lines, br, final } = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      const { o, n, ctxMap } = buildON(ch.body);
      if (ch.anchor !== null && ch.anchor !== '') {
        const tiers = strict ? [0] : [0, 1, 2];
        let anchorPos = -1;
        for (const t of tiers) {
          for (let k = cursor; k < lines.length; k++) {
            if (tierMatch(lines[k]!, ch.anchor, t)) {
              anchorPos = k;
              break;
            }
          }
          if (anchorPos >= 0) break;
        }
        if (anchorPos < 0) throw new Fail('no-match', path);
        cursor = anchorPos + 1;
      }
      if (o.length > 0) {
        const found = findFirstTier(lines, o, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let pos = -1;
        for (const p of found.occ) {
          if (ch.eof && p + o.length !== lines.length) continue;
          pos = p;
          break;
        }
        if (pos < 0) throw new Fail('no-match', path);
        lines = applyReplace(lines, o, n, pos, found.tier, ctxMap);
        cursor = pos + n.length;
      } else {
        const insertAt = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, insertAt), ...n, ...lines.slice(insertAt)];
        cursor = insertAt + n.length;
      }
    }
    const content = joinFile(lines, br, final);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, content);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, content);
    }
  };
}

/* ---- section 10: order, atomicity, output ---- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!covered.has(p)) rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
