/* Site checks the HTML and JS linters don't cover:
   - nothing is loaded from another site (scripts, styles, fonts, images, imports, fetches)
   - every local file a page or module references exists
   - every tool page is linked from index.html
   - no published file is over Cloudflare's 25 MiB limit, and no report or spreadsheet file is published at all
   - pages stay compatible with the Content-Security-Policy in _headers: no inline scripts, styles,
     style attributes or event handlers, no eval, and the policy itself stays strict */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['.git', 'node_modules', 'scripts', '.github']);
const MAX_BYTES = 25 * 1024 * 1024;
/* Customer reports are read in the browser and must never be committed, so they can never be published. */
const DATA_FILE = /\.(pdf|csv|tsv|xls|xlsx|numbers|doc|docx)$/i;
const problems = [];
const report = (file, line, msg) => problems.push(`${relative(root, file)}:${line}  ${msg}`);

/* The files a commit would publish: tracked plus untracked-but-not-ignored. Outside git, every file in the folder. */
function siteFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
    return out.split('\0').filter(Boolean)
      .filter(p => !SKIP.has(p.split('/')[0]) && !p.split('/').some(part => part.startsWith('.')))
      .map(p => join(root, p)).filter(p => existsSync(p));
  } catch (e) {
    return walk(root);
  }
}

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    if (SKIP.has(name) || name.startsWith('.')) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const isExternal = url => /^(https?:)?\/\//i.test(url);
const isIgnorable = url => /^(#|data:|blob:|mailto:|tel:|javascript:)/i.test(url) || url === '';

/* References that make the browser load something. Plain <a href> links to other sites are allowed. */
function resourceRefs(file, text) {
  const refs = [];
  const add = (re, kind) => { for (const m of text.matchAll(re)) refs.push({ url: m[1].trim(), kind, line: lineOf(text, m.index) }); };
  if (file.endsWith('.html')) {
    add(/<(?:script|img|iframe|source|audio|video|embed)\b[^>]*?\bsrc\s*=\s*["']([^"']*)["']/gi, 'src');
    add(/<link\b[^>]*?\bhref\s*=\s*["']([^"']*)["']/gi, 'link');
    add(/<a\b[^>]*?\bhref\s*=\s*["']([^"']*)["']/gi, 'a');
    add(/<img\b[^>]*?\bsrcset\s*=\s*["']([^"'\s,]*)/gi, 'srcset');
  }
  /* In a page, only look for CSS url() inside <style> blocks so script code like URL.createObjectURL(blob) is not mistaken for one. */
  const cssUrl = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  if (file.endsWith('.css')) add(cssUrl, 'css url');
  if (file.endsWith('.html')) {
    for (const block of text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
      const start = block.index + block[0].indexOf(block[1]);
      for (const m of block[1].matchAll(cssUrl)) refs.push({ url: m[1].trim(), kind: 'css url', line: lineOf(text, start + m.index) });
    }
  }
  if (/\.(html|mjs|js)$/.test(file)) {
    add(/\bimport\s*(?:[^'"]*?\bfrom\s*)?["']([^"']+)["']/g, 'import');
    add(/\bimport\(\s*["']([^"']+)["']\s*\)/g, 'import');
    add(/\bfetch\(\s*["']([^"']+)["']/g, 'fetch');
    /* new URL('../x', <this script's URL>): lib/ helpers resolve files relative to themselves. */
    add(/new URL\(\s*["']([^"']+)["']\s*,\s*(?:import\.meta\.url|base|document\.currentScript\.src)\b/g, 'url');
  }
  return refs;
}

/* Patterns the CSP blocks at runtime. In JS they are only matched inside markup strings built for innerHTML. */
const HTML_CSP_RULES = [
  [/<script\b(?![^>]*\bsrc\s*=)[^>]*>/gi, 'has an inline <script>; move it into js/'],
  [/<style\b/gi, 'has a <style> block; move it into css/'],
  [/<[a-z][^>]*\sstyle\s*=/gi, 'has a style="" attribute; use a class instead'],
  [/<[a-z][^>]*\son[a-z]+\s*=/gi, 'has an inline event handler; use addEventListener instead'],
  [/\bjavascript:/gi, 'uses a javascript: URL']
];
const JS_CSP_RULES = [
  [/['"`][^'"`\n]*<[a-z][^'"`\n>]*\sstyle\s*=/gi, 'builds markup with a style="" attribute; use a class instead'],
  [/['"`][^'"`\n]*<[a-z][^'"`\n>]*\son[a-z]+\s*=/gi, 'builds markup with an inline event handler'],
  [/\beval\s*\(|\bnew\s+Function\s*\(/g, 'uses eval or new Function'],
  [/\bset(?:Timeout|Interval)\s*\(\s*['"`]/g, 'passes a string to setTimeout/setInterval']
];
function cspChecks(file, text) {
  const rules = file.endsWith('.html') ? HTML_CSP_RULES : /\.(m?js)$/.test(file) ? JS_CSP_RULES : [];
  for (const [re, msg] of rules) for (const m of text.matchAll(re)) report(file, lineOf(text, m.index), `${msg} (blocked by the CSP)`);
}

function checkHeaders() {
  const file = join(root, '_headers');
  if (!existsSync(file)) return report(file, 1, 'is missing, so pages are served without a Content-Security-Policy');
  const text = readFileSync(file, 'utf8');
  const m = text.match(/^\s+Content-Security-Policy:\s*(.+)$/mi);
  if (!m) return report(file, 1, 'has no Content-Security-Policy header');
  const line = lineOf(text, m.index + 1);
  const csp = Object.fromEntries(m[1].split(';').map(d => d.trim().split(/\s+/)).filter(d => d[0]).map(([k, ...v]) => [k.toLowerCase(), v]));
  if (!/^\/\*\s*$/m.test(text)) report(file, 1, 'does not apply its headers to every path (/*)');
  if ((csp['default-src'] || []).join(' ') !== "'none'") report(file, line, "CSP default-src should be 'none'");
  for (const d of ['script-src', 'style-src', 'connect-src', 'frame-ancestors', 'base-uri', 'object-src']) {
    if (!csp[d]) report(file, line, `CSP is missing ${d}`);
  }
  for (const [d, values] of Object.entries(csp)) {
    for (const v of values) {
      if (/^'unsafe-|^\*$|^https?:$|^https?:\/\//i.test(v)) report(file, line, `CSP ${d} allows ${v}`);
    }
  }
}

const files = siteFiles();
const pages = files.filter(f => f.endsWith('.html'));

for (const file of files) {
  const size = statSync(file).size;
  if (size > MAX_BYTES) report(file, 1, `is ${(size / 1048576).toFixed(1)} MiB, over Cloudflare's 25 MiB per-file limit`);
  if (DATA_FILE.test(file)) report(file, 1, 'is a report or data file and would be published; remove it from the repo');
  /* Third-party code in vendor/ is not ours to lint, apart from the font stylesheet. */
  const vendored = file.startsWith(join(root, 'vendor') + '/') && !file.endsWith('.css');
  if (!/\.(html|css|mjs|js)$/.test(file) || vendored) continue;

  const text = readFileSync(file, 'utf8');
  cspChecks(file, text);
  for (const { url, kind, line } of resourceRefs(file, text)) {
    if (isIgnorable(url)) continue;
    if (kind === 'import' && !/^(\.{1,2}\/|\/)/.test(url) && !isExternal(url)) continue; /* package name, e.g. in eslint.config.js */
    if (isExternal(url)) {
      if (kind !== 'a') report(file, line, `loads ${url} from another site; copy it into vendor/ instead`);
      continue;
    }
    const path = url.split(/[?#]/)[0];
    const target = resolve(dirname(file), path.endsWith('/') ? path + 'index.html' : path);
    if (!existsSync(target)) report(file, line, `${kind} points to ${url}, which does not exist`);
  }
}

checkHeaders();

const index = join(root, 'index.html');
if (!existsSync(index)) {
  report(index, 1, 'is missing');
} else {
  const indexText = readFileSync(index, 'utf8');
  for (const page of pages) {
    const name = relative(root, page);
    if (name === 'index.html' || name.includes('/')) continue;
    if (!indexText.includes(`href="${name}"`)) report(index, 1, `does not link to ${name}`);
  }
}

if (problems.length) {
  console.error(problems.join('\n') + `\n\n✖ ${problems.length} site problem${problems.length === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log(`Site check passed: ${pages.length} pages, ${files.length} files.`);
