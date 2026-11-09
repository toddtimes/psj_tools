import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../site/js/mailbox-name-labels.js', import.meta.url), 'utf8');
const pure = src.slice(0, src.indexOf('\n(function () {'));
const ctx = {}; vm.createContext(ctx); vm.runInContext(pure, ctx);
const MNL = ctx.MNL;
/* crude Helvetica-ish: 0.55 em per char, bold 0.6 */
const measure = (t, size, bold) => t.length * (bold ? 0.6 : 0.55) * size / 72;
const PAD_X = 0.19, PAD_TOP = 0.17, PAD_BOTTOM = 0.15, CAP = 0.718, DESC = 0.22, RULE_BELOW = 0.075, RULE_ABOVE = 0.085;

function nameRuns(lay, pi = 0) { return lay.parts[pi].runs.filter(r => r.kind === 'name'); }
function headTop(lay) { const nums = lay.parts[0].runs.filter(r => r.kind === 'num' || r.kind === 'head'); return Math.min(...nums.map(r => r.y - r.size * CAP / 72)); }
function headBottom(lay) { const nums = lay.parts[0].runs.filter(r => r.kind === 'num' || r.kind === 'head'); return Math.max(...nums.map(r => r.y)); }
function rule(lay) { return lay.parts[0].runs.find(r => r.kind === 'rule'); }

const names = ['SMITH, JANE', 'DOE, JOHN', 'ACME WIDGETS LLC'];
const combos = [];
for (const stock of ['royal8', 'avery5164']) for (const rotate of [0, 90]) for (const numberAtBottom of [false, true])
  for (const repeat of [false, true]) for (const namesV of ['top', 'bottom']) for (const namesH of ['left', 'right'])
    combos.push({ stock, rotate, numberAtBottom, repeat, namesV, namesH, showNumber: true, lastNames: ['SMITH', 'DOE'], sep: '&', minPt: 10.5 });

for (const opts of combos) {
  const tag = JSON.stringify(opts);
  test('names stay inside the frame and clear of the head line: ' + tag, () => {
    const lay = MNL.layoutBox(101, names, opts, measure);
    assert.ok(lay.fits);
    const W = lay.W, H = lay.H, r = rule(lay);
    const asc = lay.size * CAP / 72, desc = lay.size * DESC / 72;
    const areaTop = opts.numberAtBottom ? PAD_TOP : r.y + RULE_ABOVE;
    const areaBottom = opts.numberAtBottom ? r.y - RULE_BELOW : H - PAD_BOTTOM;
    const runs = nameRuns(lay);
    assert.ok(runs.length >= 3);
    for (const n of runs) {
      assert.ok(n.y - asc >= areaTop - 1e-9, `name top ${n.y - asc} above area top ${areaTop}`);
      assert.ok(n.y + desc <= areaBottom + 1e-9, `name bottom ${n.y + desc} below area bottom ${areaBottom}`);
      assert.ok(n.x >= PAD_X - 1e-9, 'x inside left pad');
      assert.ok(n.x + measure(n.text, n.size) <= W - PAD_X + 1e-9, 'x inside right pad');
      if (opts.namesH === 'right') assert.ok(Math.abs(n.x + measure(n.text, n.size) - (W - PAD_X)) < 1e-9, 'flush right');
      else assert.ok(Math.abs(n.x - PAD_X) < 1e-9, 'flush left');
    }
    const first = runs[0], last = runs[runs.length - 1];
    if (opts.namesV === 'bottom') assert.ok(Math.abs(last.y + desc - areaBottom) < 1e-9, `last descender ${last.y + desc} should meet ${areaBottom}`);
    else assert.ok(Math.abs(first.y - asc - areaTop) < 1e-9, 'first cap should meet area top');
    /* head line itself within the label */
    assert.ok(headTop(lay) >= PAD_TOP - 1e-9 && headBottom(lay) <= H - PAD_BOTTOM + 1e-9, 'head line inside label');
    /* every run maps inside the label on the sheet */
    const L = MNL.getStock(opts.stock).label;
    for (const n of runs) { const p = MNL.toLabel(n.x, n.y, lay.rot, opts.stock); assert.ok(p.x >= 0 && p.x <= L.w && p.y >= 0 && p.y <= L.h, 'mapped inside label'); }
  });
}

test('overflow labels: bottom alignment on continuation labels meets H - PAD_BOTTOM', () => {
  const many = Array.from({ length: 14 }, (_, i) => 'PERSON NUMBER ' + i + ', FIRSTNAME');
  const opts = { stock: 'royal8', rotate: 0, showNumber: true, numberAtBottom: false, namesV: 'bottom', namesH: 'right', minPt: 10.5, lastNames: [] };
  const lay = MNL.layoutBox(5, many, opts, measure);
  assert.ok(lay.parts.length > 1, 'should run onto extra labels');
  const desc = lay.size * DESC / 72;
  for (let pi = 1; pi < lay.parts.length; pi++) {
    const runs = nameRuns(lay, pi);
    assert.ok(runs.length);
    assert.equal(lay.parts[pi].runs.filter(r => r.kind !== 'name').length, 0, 'no head on continuation');
    if (pi < lay.parts.length - 1 || runs.length) {
      const last = runs[runs.length - 1];
      assert.ok(Math.abs(last.y + desc - (lay.H - PAD_BOTTOM)) < 1e-9, `part ${pi} bottom ${last.y + desc} vs ${lay.H - PAD_BOTTOM}`);
    }
  }
});

test('wrapped name: continuation lines indent on the aligned edge', () => {
  const opts = { stock: 'royal8', rotate: 90, showNumber: false, namesV: 'top', namesH: 'right', minPt: 10.5 };
  const lay = MNL.layoutBox(5, ['A VERY LONG BUSINESS NAME THAT WRAPS ONTO TWO LINES INC'], opts, measure);
  const runs = nameRuns(lay);
  assert.ok(runs.length >= 2);
  const right = r => r.x + measure(r.text, r.size);
  assert.ok(Math.abs(right(runs[0]) - (lay.W - PAD_X)) < 1e-9);
  assert.ok(Math.abs(right(runs[1]) - (lay.W - PAD_X - 0.13)) < 1e-9, 'second line indented from right');
});

test('a name taller than the label is clamped at the top instead of pushed off', () => {
  const opts = { stock: 'royal8', rotate: 0, showNumber: true, namesV: 'bottom', namesH: 'left', minPt: 12 };
  const giant = Array.from({ length: 30 }, () => 'WORDWORDWORDWORDWORDWORD').join(' ');
  const lay = MNL.layoutBox(5, [giant], opts, measure);
  assert.equal(lay.fits, false);
  const runs = nameRuns(lay);
  assert.ok(Math.abs(runs[0].y - lay.size * CAP / 72 - (rule(lay).y + RULE_ABOVE)) < 1e-9);
});
