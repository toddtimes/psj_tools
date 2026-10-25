/* Site checks the HTML and JS linters don't cover. Everything in site/ is published as-is.
   - nothing in site/ loads from another site (scripts, styles, fonts, images, imports)
   - every local file a page or script references exists
   - every tool page is linked from index.html
   - no report or spreadsheet file is anywhere in the repo, and no published file is over 25 MiB
   - pages stay compatible with the Content-Security-Policy in site/_headers (no inline scripts, styles,
     style attributes or event handlers), and the policy only ever allows 'self' or 'none'
   Markup assembled from several string pieces can slip past the inline checks; the CSP still blocks it
   at runtime. eval, string timers and network calls are caught by ESLint (eslint.config.js). */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const site = join(root, 'site');
const MAX_BYTES = 25 * 1024 * 1024;
/* Customer reports are read in the browser and must never be committed. */
const DATA_FILE = /\.(pdf|csv|tsv|xls|xlsx|xlsm|numbers|ods|doc|docx|rtf)$/i;
/* The only CSP source values this site needs. Anything else (a host, a scheme, a nonce, 'unsafe-…') widens it. */
const CSP_VALUES = new Set(["'self'", "'none'"]);
const CSP_REQUIRED = ['default-src', 'script-src', 'worker-src', 'style-src', 'font-src', 'img-src', 'connect-src', 'object-src', 'base-uri', 'form-action', 'frame-ancestors'];
const problems = [];
const report = (file, line, msg) => problems.push(`${relative(root, file)}:${line}  ${msg}`);

function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/* Every file a commit could contain: tracked, plus untracked files that aren't ignored. */
function repoFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' });
    return out.split('\0').filter(Boolean).map(p => join(root, p));
  } catch (e) {
    return walk(root).filter(p => !/\/(\.git|node_modules)\//.test(p));
  }
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const isExternal = url => /^([a-z][a-z0-9+.-]*:)?\/\//i.test(url);
const isIgnorable = url => /^(#|data:|blob:|mailto:|tel:)/i.test(url) || url === '';

/* References that make the browser load something. Plain <a href> links to other sites are allowed. */
function resourceRefs(file, text) {
  const refs = [];
  const add = (re, kind) => { for (const m of text.matchAll(re)) refs.push({ url: m[1].trim(), kind, line: lineOf(text, m.index) }); };
  if (file.endsWith('.html')) {
    add(/<(?:script|img|iframe|source|audio|video|embed|track|input)\b[^>]*?\bsrc\s*=\s*["']([^"']*)["']/gi, 'src');
    add(/<(?:object)\b[^>]*?\bdata\s*=\s*["']([^"']*)["']/gi, 'data');
    add(/<(?:link|base)\b[^>]*?\bhref\s*=\s*["']([^"']*)["']/gi, 'link');
    add(/<(?:a|area)\b[^>]*?\bhref\s*=\s*["']([^"']*)["']/gi, 'a');
    add(/<form\b[^>]*?\baction\s*=\s*["']([^"']*)["']/gi, 'form');
    add(/<meta\b[^>]*?http-equiv\s*=\s*["']?refresh[^>]*?content\s*=\s*["'][^"']*url=([^"']*)["']/gi, 'refresh');
    for (const m of text.matchAll(/\bsrcset\s*=\s*["']([^"']*)["']/gi)) {
      for (const candidate of m[1].split(',')) refs.push({ url: candidate.trim().split(/\s+/)[0], kind: 'srcset', line: lineOf(text, m.index) });
    }
  }
  if (file.endsWith('.css')) {
    add(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, 'css url');
    add(/@import\s+["']([^"']+)["']/gi, 'css import');
  }
  if (file.endsWith('.js') || file.endsWith('.mjs')) {
    add(/\bimport\s*(?:[^'"]*?\bfrom\s*)?["']([^"']+)["']/g, 'import');
    add(/\bimport\(\s*["']([^"']+)["']\s*\)/g, 'import');
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
  [/['"`][^'"`\n]*<[a-z][^'"`\n>]*\son[a-z]+\s*=/gi, 'builds markup with an inline event handler']
];
function cspChecks(file, text) {
  const rules = file.endsWith('.html') ? HTML_CSP_RULES : /\.m?js$/.test(file) ? JS_CSP_RULES : [];
  for (const [re, msg] of rules) for (const m of text.matchAll(re)) report(file, lineOf(text, m.index), `${msg} (blocked by the CSP)`);
}

function checkHeaders() {
  const file = join(site, '_headers');
  if (!existsSync(file)) return report(file, 1, 'is missing, so pages are served without a Content-Security-Policy');
  const text = readFileSync(file, 'utf8');
  if (!/^\/\*\s*$/m.test(text)) report(file, 1, 'does not apply its headers to every path (/*)');
  const m = text.match(/^\s+Content-Security-Policy:\s*(.+)$/mi);
  if (!m) return report(file, 1, 'has no Content-Security-Policy header');
  const line = lineOf(text, m.index + 1);
  const csp = {};
  for (const part of m[1].split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) csp[name.toLowerCase()] = values;
  }
  if ((csp['default-src'] || []).join(' ') !== "'none'") report(file, line, "CSP default-src must be 'none'");
  for (const d of CSP_REQUIRED) if (!csp[d]) report(file, line, `CSP is missing ${d}`);
  for (const [d, values] of Object.entries(csp)) {
    if (!values.length) report(file, line, `CSP ${d} has no value`);
    for (const v of values) if (!CSP_VALUES.has(v)) report(file, line, `CSP ${d} allows ${v}; only 'self' or 'none' are expected`);
  }
}

for (const file of repoFiles()) {
  if (DATA_FILE.test(file)) report(file, 1, 'is a report or data file; never commit these, they can contain customer details');
}

if (!existsSync(site)) {
  report(site, 1, 'is missing');
} else {
  const files = walk(site);
  for (const file of files) {
    const size = statSync(file).size;
    if (size > MAX_BYTES) report(file, 1, `is ${(size / 1048576).toFixed(1)} MiB, over Cloudflare's 25 MiB per-file limit`);
    /* Third-party code in vendor/ is not ours to lint, apart from the font stylesheet. */
    const vendored = file.startsWith(join(site, 'vendor') + '/') && !file.endsWith('.css');
    if (!/\.(html|css|mjs|js)$/.test(file) || vendored) continue;

    const text = readFileSync(file, 'utf8');
    cspChecks(file, text);
    for (const { url, kind, line } of resourceRefs(file, text)) {
      if (isIgnorable(url)) continue;
      if (isExternal(url)) {
        if (kind !== 'a') report(file, line, `loads ${url} from another site; copy it into site/vendor/ instead`);
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) { report(file, line, `${kind} uses an unexpected URL scheme: ${url}`); continue; }
      const path = url.split(/[?#]/)[0];
      const target = path.startsWith('/') ? join(site, path) : resolve(dirname(file), path);
      const resolved = path.endsWith('/') ? join(target, 'index.html') : target;
      if (!resolved.startsWith(site)) report(file, line, `${kind} points outside site/: ${url}`);
      else if (!existsSync(resolved)) report(file, line, `${kind} points to ${url}, which does not exist`);
    }
  }

  checkHeaders();

  const index = join(site, 'index.html');
  const pages = files.filter(f => f.endsWith('.html') && dirname(f) === site && f !== index);
  if (!existsSync(index)) {
    report(index, 1, 'is missing');
  } else {
    const indexText = readFileSync(index, 'utf8');
    for (const page of pages) {
      const name = relative(site, page);
      if (!indexText.includes(`href="${name}"`)) report(index, 1, `does not link to ${name}`);
    }
  }
  if (!problems.length) console.log(`Site check passed: ${pages.length + 1} pages, ${files.length} published files.`);
}

if (problems.length) {
  console.error(problems.join('\n') + `\n\n✖ ${problems.length} site problem${problems.length === 1 ? '' : 's'}`);
  process.exit(1);
}
