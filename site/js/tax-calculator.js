(function () {
  'use strict';

  const DEFAULT_RETAIL = ['Packing Materials', 'Gift Wrap and Totes', 'Misc Non-Taxable', 'Postage Stamps', 'Greeting Cards', 'Misc. Retail', 'Envelopes / Mailers', 'Holiday', 'OTC Packing Supplies', 'Gift Boxes'];
  const DEFAULT_SERVICES = ['Shipping', 'Insurance', 'Copies', 'Mailbox Rentals', 'Labor', 'Laminating', 'FedEx', 'UPS', 'USPS', 'Service Fee', 'Fax / Email', 'Shredding'];

  const store = Site.store;

  const savedLists = store.get('ptt.lists.v2', null);
  let lists = savedLists && Array.isArray(savedLists.retail) && Array.isArray(savedLists.services)
    ? savedLists : { retail: DEFAULT_RETAIL.slice(), services: DEFAULT_SERVICES.slice() };

  /* A base cost is a fixed monthly cost the report does not know about, such as rent behind Mailbox Rentals.
     Rows keep exactly what was typed so a half-entered amount is never lost; only valid rows are applied.
     v1 stored parsed { name, monthly } pairs and is carried over once. */
  const savedCosts = store.get('ptt.costs.v2', null) ||
    (store.get('ptt.costs.v1', []) || []).map(c => ({ name: c && c.name, amount: c && c.monthly != null ? String(c.monthly) : '' }));
  let costRows = (Array.isArray(savedCosts) ? savedCosts : [])
    .filter(c => c && typeof c.name === 'string' && typeof c.amount === 'string')
    .map(c => ({ name: c.name, amount: c.amount }));

  const state = { profit: null, tax: null, errors: [] };

  const $ = id => document.getElementById(id);
  const esc = Site.esc;
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const cents = v => (v == null ? 0 : Math.round(v * 100));
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const money = c => usd.format(c / 100);
  const plain = c => (c / 100).toFixed(2);

  /* ---------- Reading the PDFs ---------- */

  function buildLines(items) {
    const rows = [];
    items.filter(i => i.s.trim()).sort((a, b) => b.y - a.y || a.x - b.x).forEach(it => {
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.y - it.y) <= 2.5) last.items.push(it);
      else rows.push({ y: it.y, items: [it] });
    });
    return rows.map(r => {
      r.items.sort((a, b) => a.x - b.x);
      let text = '';
      r.items.forEach((it, i) => {
        if (i > 0) {
          const prev = r.items[i - 1];
          if (it.x - (prev.x + prev.w) > 1) text += ' ';
        }
        text += it.s;
      });
      text = text.replace(/\s+/g, ' ').trim();
      return { text, tokens: text.split(' ') };
    });
  }

  async function readPdf(file) {
    const pages = await PdfReader.readPages(file);
    return pages.map(items => buildLines(items.map(i => ({ x: i.x, y: i.y, w: i.w, s: i.str }))));
  }

  function parseNum(tok) {
    if (tok == null) return null;
    const t = tok.replace(/[$,%]/g, '');
    if (!/^-?\(?\d*\.?\d+\)?$/.test(t)) return null;
    const neg = /^\(.*\)$/.test(t) || t.startsWith('-');
    const n = parseFloat(t.replace(/[()-]/g, ''));
    return neg ? -n : n;
  }
  const isValueToken = t => /^(N\/A|-?\(?\$?[\d,]*\.?\d+\)?%?)$/i.test(t);

  function findRange(pages) {
    for (const lines of pages) for (const l of lines) {
      const m = l.text.match(/From\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+To\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
      if (m) return { from: m[1], to: m[2] };
    }
    return null;
  }

  function parseProfit(pages, fileName) {
    const out = { fileName, range: findRange(pages), depts: [], totals: null, problems: [] };
    const headerish = t => /^(Profit Report|From \d|Department\b)/i.test(t) || /\bPage \d+$/i.test(t) || /\bVersion [\d.]+$/i.test(t) || /\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}/.test(t);
    let current = null;
    let pendingLabel = null;
    const setRow = (label, vals) => {
      if (!current) return;
      if (vals.length < 4) out.problems.push('A ' + label + ' line under ' + current.name + ' could not be read.');
      current[label.toLowerCase()] = { count: parseNum(vals[0]), retail: parseNum(vals[1]), wholesale: parseNum(vals[2]), gp: parseNum(vals[3]) };
    };
    for (const lines of pages) {
      const hasHeader = lines.some(l => /^Department\b.*\bRetail\b/i.test(l.text));
      let inBody = !hasHeader;
      for (const l of lines) {
        if (!inBody) { if (/^Department\b.*\bRetail\b/i.test(l.text)) inBody = true; continue; }
        if (!hasHeader && headerish(l.text)) continue;
        const first = l.tokens[0];
        if (/^(Hard|Soft|Combined)$/i.test(first)) {
          const label = first[0].toUpperCase() + first.slice(1).toLowerCase();
          if (l.tokens.length === 1) { pendingLabel = label; continue; }
          setRow(label, l.tokens.slice(1));
          pendingLabel = null;
        } else if (pendingLabel && l.tokens.every(isValueToken)) {
          setRow(pendingLabel, l.tokens);
          pendingLabel = null;
        } else if (/^Totals:?$/i.test(l.text)) {
          current = { name: 'Totals' };
          out.totals = current;
        } else {
          current = { name: l.text };
          out.depts.push(current);
        }
      }
    }
    out.depts = out.depts.filter(d => d.hard || d.soft || d.combined);
    return out;
  }

  function parseTax(pages, fileName) {
    const out = { fileName, range: findRange(pages), regions: [], gross: null };
    let region = null;
    for (const lines of pages) for (const l of lines) {
      const m = l.text.match(/^Tax Region:\s*(.+)$/i);
      if (m) { region = { name: m[1].trim(), taxable: null, collected: null }; out.regions.push(region); continue; }
      const last = parseNum(l.tokens[l.tokens.length - 1]);
      if (/^Total taxable sales\b/i.test(l.text)) {
        if (!region) { region = { name: 'Unnamed region', taxable: null, collected: null }; out.regions.push(region); }
        region.taxable = last;
      } else if (/^Total taxes collected\b/i.test(l.text) && region) {
        region.collected = last;
      } else if (/^Gross Sales\b/i.test(l.text)) {
        out.gross = last;
      }
    }
    return out;
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    state.errors = [];
    if (!files.length) { state.errors.push('Those files are not PDFs.'); render(); return; }
    for (const file of files) {
      try {
        const pages = await readPdf(file);
        const all = pages.map(p => p.map(l => l.text).join('\n')).join('\n');
        if (!all.trim()) { state.errors.push(file.name + ' has no readable text. It may be a scan; export the report as a PDF from the point-of-sale system instead.'); continue; }
        if (/Sales Tax Report/i.test(all)) {
          const t = parseTax(pages, file.name);
          if (!t.regions.some(r => r.taxable != null)) { state.errors.push(file.name + ' looks like a Sales Tax Report, but no "Total taxable sales" line was found.'); continue; }
          state.tax = t;
        } else if (/Profit Report/i.test(all)) {
          const p = parseProfit(pages, file.name);
          if (!p.depts.length) { state.errors.push(file.name + ' looks like a Profit Report, but no departments were found.'); continue; }
          state.profit = p;
        } else {
          state.errors.push(file.name + ' is not a Profit Report or a Sales Tax Report.');
        }
      } catch (e) {
        state.errors.push(file.name + ' could not be read. ' + (e && e.message ? e.message : ''));
      }
    }
    render();
  }

  /* ---------- Adding up ---------- */

  function deptFigures(d) {
    const parts = [d.hard, d.soft].filter(Boolean);
    const comb = d.combined || {};
    const sumOf = key => parts.reduce((s, r) => s + cents(r[key]), 0);
    const anyOf = key => parts.some(r => r[key] != null);
    const sales = comb.retail != null ? cents(comb.retail) : sumOf('retail');
    const cost = comb.wholesale != null ? cents(comb.wholesale) : (anyOf('wholesale') ? sumOf('wholesale') : null);
    /* A line with a gross profit uses it. A line with sales but N/A for gross profit has no cost basis, so its sales count in full. */
    if (!parts.length) {
      const noBasis = comb.gp == null ? cents(comb.retail) : 0;
      return { sales, cost, profit: comb.gp != null ? cents(comb.gp) : noBasis, noCost: noBasis };
    }
    const noCost = parts.reduce((s, r) => s + (r.gp == null ? cents(r.retail) : 0), 0);
    const profit = sumOf('gp') + noCost;
    return { sales, cost, profit, noCost };
  }

  /* Months a date range covers. Whole months count as 1; a partly covered month counts by its share of days. */
  function monthsCovered(range) {
    if (!range) return null;
    const a = new Date(toDate(range.from)), b = new Date(toDate(range.to));
    if (isNaN(a) || isNaN(b) || b < a) return null;
    let total = 0, y = a.getFullYear(), m = a.getMonth();
    while (y < b.getFullYear() || (y === b.getFullYear() && m <= b.getMonth())) {
      const days = new Date(y, m + 1, 0).getDate();
      const first = y === a.getFullYear() && m === a.getMonth() ? a.getDate() : 1;
      const last = y === b.getFullYear() && m === b.getMonth() ? b.getDate() : days;
      total += (last - first + 1) / days;
      if (m === 11) { y++; m = 0; } else { m++; }
    }
    return Math.round(total * 100) / 100;
  }

  function addUp(names) {
    const index = {};
    state.profit.depts.forEach(d => { const k = norm(d.name); if (!(k in index)) index[k] = d; });
    const months = monthsCovered(state.profit.range);
    const monthly = costsByDept();
    const rows = [];
    const seen = new Set();
    names.forEach(name => {
      const key = norm(name);
      if (!key || seen.has(key)) return;
      seen.add(key);
      const d = index[key];
      if (!d) { rows.push({ key, name, missing: true, sales: 0, cost: null, profit: 0, noCost: 0 }); return; }
      const f = deptFigures(d);
      /* With a base cost the department has a cost basis, so profit is its sales less the report's cost and the base cost. */
      const perMonth = monthly[key] || 0;
      const base = perMonth && months != null ? Math.round(perMonth * months) : 0;
      rows.push({ key, name: d.name, missing: false, sales: f.sales, cost: base ? (f.cost || 0) + base : f.cost, profit: f.profit - base, noCost: base ? 0 : f.noCost, base, perMonth, unapplied: perMonth > 0 && months == null });
    });
    const total = rows.reduce((s, r) => s + r.profit, 0);
    const added = rows.reduce((s, r) => s + r.noCost, 0);
    const baseTotal = rows.reduce((s, r) => s + (r.base || 0), 0);
    return { rows, total, added, baseTotal, months, keys: seen };
  }

  function taxTotal() { return state.tax.regions.reduce((s, r) => s + cents(r.taxable), 0); }

  function reconcile() {
    const p = state.profit;
    if (!p.totals || !p.totals.hard) return null;
    const sum = (part, key) => p.depts.reduce((s, d) => s + (d[part] ? cents(d[part][key]) : 0), 0);
    const checks = [['hard', 'gp'], ['hard', 'retail'], ['soft', 'retail'], ['combined', 'retail']].filter(([part, key]) => p.totals[part] && p.totals[part][key] != null);
    /* The report rounds each line, so its Totals line can sit a few cents from the sum of the lines. */
    const allowed = p.depts.length;
    const gaps = checks.map(([part, key]) => Math.abs(sum(part, key) - cents(p.totals[part][key])));
    const worst = gaps.length ? Math.max.apply(null, gaps) : 0;
    const sales = p.totals.combined && p.totals.combined.retail != null ? cents(p.totals.combined.retail) : null;
    return { ok: worst <= allowed, gap: worst, sales };
  }

  /* ---------- Showing it ---------- */

  let result = { retail: null, services: null, tax: null };

  function slotHtml(kind, data) {
    const title = kind === 'profit' ? 'Profit Report' : 'Sales Tax Report';
    if (!data) return '<span class="label">' + title + '</span><span class="file">Not added yet</span><span class="state">Waiting for this report</span>';
    const range = data.range ? data.range.from + ' to ' + data.range.to : 'Date range not found';
    return '<span class="label">' + title + '</span><span class="file">' + esc(data.fileName) + '</span><span class="state">' + esc(range) + '</span>';
  }

  function ledgerHtml(title, sum) {
    const body = sum.rows.map(r => {
      if (r.missing) return '<tr class="missing"><td>' + esc(r.name) + ' <span class="tag">not on this report</span></td><td class="n">—</td><td class="n">—</td><td class="n">—</td><td class="n">—</td></tr>';
      const nc = r.noCost !== 0 ? money(r.noCost) : '—';
      const baseTag = r.base ? ' <span class="tag">base cost ' + money(r.perMonth) + ' a month × ' + sum.months + (sum.months === 1 ? ' month' : ' months') + '</span>' : '';
      return '<tr><td>' + esc(r.name) + baseTag + '</td><td class="n">' + money(r.sales) + '</td><td class="n">' + (r.cost == null ? '—' : money(r.cost)) + '</td><td class="n profit">' + money(r.profit) + '</td><td class="n">' + nc + '</td></tr>';
    }).join('');
    const tSales = sum.rows.reduce((s, r) => s + r.sales, 0);
    const tCost = sum.rows.reduce((s, r) => s + (r.cost || 0), 0);
    const tNo = sum.rows.reduce((s, r) => s + r.noCost, 0);
    return '<div class="ledger-head"><h2>' + title + '</h2><span class="muted">' + sum.rows.length + ' categories</span></div>' +
      '<div class="scroll"><table><thead><tr><th>Department</th><th>Sales</th><th>Cost</th><th>Profit</th><th>From no-cost sales</th></tr></thead><tbody>' + body +
      '</tbody><tfoot><tr><td>Total</td><td class="n">' + money(tSales) + '</td><td class="n">' + money(tCost) + '</td><td class="n">' + money(sum.total) + '</td><td class="n">' + (tNo ? money(tNo) : '—') + '</td></tr></tfoot></table></div>';
  }

  function figureSub(sum) {
    const bits = [sum.rows.filter(r => !r.missing).length + ' categories'];
    if (sum.added) bits.push('includes ' + money(sum.added) + ' of sales with no cost on the report, counted in full');
    if (sum.baseTotal) bits.push('after ' + money(sum.baseTotal) + ' in base costs');
    return bits.join(' · ');
  }

  function toDate(s) { const m = s.split('/').map(Number); return new Date(m[2] < 100 ? 2000 + m[2] : m[2], m[0] - 1, m[1]).getTime(); }

  function render() {
    const notices = [];
    state.errors.forEach(e => notices.push({ cls: 'error', html: esc(e) }));

    $('slot-profit').className = 'slot ' + (state.profit ? 'ready' : 'empty');
    $('slot-profit').innerHTML = slotHtml('profit', state.profit);
    $('slot-tax').className = 'slot ' + (state.tax ? 'ready' : 'empty');
    $('slot-tax').innerHTML = slotHtml('tax', state.tax);

    result = { retail: null, services: null, tax: null };
    let anyNoCost = false;

    if (state.profit) {
      const retail = addUp(lists.retail);
      const services = addUp(lists.services);
      result.retail = retail.total;
      result.services = services.total;
      anyNoCost = retail.rows.concat(services.rows).some(r => r.noCost !== 0);

      $('val-retail').textContent = money(retail.total);
      $('val-services').textContent = money(services.total);
      $('sub-retail').textContent = figureSub(retail);
      $('sub-services').textContent = figureSub(services);
      $('ledger-retail').innerHTML = ledgerHtml('Retail', retail);
      $('ledger-services').innerHTML = ledgerHtml('Services', services);

      state.profit.problems.forEach(p => notices.push({ cls: '', html: esc(p) }));

      const listed = retail.rows.concat(services.rows);
      if (listed.some(r => r.unapplied)) notices.push({ cls: '', html: 'No date range was found on this Profit Report, so monthly base costs were <strong>not</strong> taken off.' });
      else if (listed.some(r => r.base) && retail.months % 1 !== 0) notices.push({ cls: '', html: 'This Profit Report covers <strong>' + retail.months + ' months</strong>, not a whole number, so monthly base costs are scaled to match.' });

      const both = retail.rows.filter(r => !r.missing && services.keys.has(r.key));
      both.forEach(r => notices.push({ cls: '', html: '<strong>' + esc(r.name) + '</strong> is in both lists, so its ' + money(r.profit) + ' profit is counted in the retail total and again in the services total.' }));

      const missing = retail.rows.concat(services.rows).filter(r => r.missing).map(r => r.name);
      if (missing.length) notices.push({ cls: '', html: 'Not found on this Profit Report: <strong>' + esc(Array.from(new Set(missing)).join(', ')) + '</strong>. Check the spelling under Categories.' });

      const unlisted = state.profit.depts.filter(d => !retail.keys.has(norm(d.name)) && !services.keys.has(norm(d.name)));
      const active = unlisted.filter(d => deptFigures(d).sales !== 0);
      if (active.length) notices.push({ cls: '', html: 'On the report with sales, but in neither list: <strong>' + esc(active.map(d => d.name + ' (' + money(deptFigures(d).sales) + ')').join(', ')) + '</strong>.' });
      const idle = unlisted.filter(d => deptFigures(d).sales === 0).map(d => d.name);

      const rec = reconcile();
      let line = 'Read ' + state.profit.depts.length + ' departments.';
      if (rec && rec.ok) {
        line += rec.gap === 0 ? ' Department figures add up to the report\'s own Totals line' : ' Department figures add up to within ' + money(rec.gap) + ' of the report\'s own Totals line, which rounds each line';
        line += rec.sales != null ? ' (' + money(rec.sales) + ' in sales).' : '.';
      }
      else if (rec) notices.push({ cls: 'error', html: 'The department figures read from this report do not add up to its Totals line, so a number may have been misread. Check the breakdown below against the PDF.' });
      if (idle.length) line += ' In neither list, with no sales: ' + idle.join(', ') + '.';
      $('check-line').textContent = line;
    } else {
      ['retail', 'services'].forEach(k => {
        $('val-' + k).textContent = '—';
        $('sub-' + k).textContent = 'Add a Profit Report';
        $('ledger-' + k).innerHTML = '';
      });
      $('check-line').textContent = '';
    }

    if (state.tax) {
      const total = taxTotal();
      result.tax = total;
      $('val-tax').textContent = money(total);
      const withTaxable = state.tax.regions.filter(r => r.taxable != null);
      $('sub-tax').textContent = withTaxable.length === 1 ? 'From ' + withTaxable[0].name : 'Sum of ' + withTaxable.length + ' tax regions';
      $('ledger-tax').innerHTML = '<div class="ledger-head"><h2>Taxable sales by region</h2></div><div class="scroll"><table class="narrow"><thead><tr><th>Tax region</th><th>Taxes collected</th><th>Total taxable sales</th></tr></thead><tbody>' +
        state.tax.regions.map(r => '<tr><td>' + esc(r.name) + '</td><td class="n">' + (r.collected == null ? '—' : money(cents(r.collected))) + '</td><td class="n profit">' + (r.taxable == null ? '—' : money(cents(r.taxable))) + '</td></tr>').join('') +
        '</tbody><tfoot><tr><td>Total</td><td class="n">' + money(state.tax.regions.reduce((s, r) => s + cents(r.collected), 0)) + '</td><td class="n">' + money(total) + '</td></tr></tfoot></table></div>';
    } else {
      $('val-tax').textContent = '—';
      $('sub-tax').textContent = 'Add a Sales Tax Report';
      $('ledger-tax').innerHTML = '';
    }

    if (state.profit && state.tax && state.profit.range && state.tax.range) {
      const a = state.profit.range, b = state.tax.range;
      if (toDate(a.from) !== toDate(b.from) || toDate(a.to) !== toDate(b.to)) {
        notices.unshift({ cls: '', html: '<strong>The two reports cover different dates.</strong> Profit Report: ' + esc(a.from) + ' to ' + esc(a.to) + '. Sales Tax Report: ' + esc(b.from) + ' to ' + esc(b.to) + '. Run one of them again so both cover the same period.' });
      } else {
        const sales = state.profit.totals && state.profit.totals.combined ? state.profit.totals.combined.retail : null;
        if (sales != null && state.tax.gross != null) {
          if (cents(sales) === cents(state.tax.gross)) $('check-line').textContent += ' Total sales match Gross Sales on the Sales Tax Report.';
          else notices.push({ cls: '', html: 'Total sales on the Profit Report (' + money(cents(sales)) + ') differ from Gross Sales on the Sales Tax Report (' + money(cents(state.tax.gross)) + '), even though both cover the same dates.' });
        }
      }
    }

    ['retail', 'services', 'tax'].forEach(k => {
      $('val-' + k).classList.toggle('pending', result[k] == null);
      $('copy-' + k).disabled = result[k] == null;
    });
    $('copy-all').disabled = result.retail == null && result.tax == null;
    $('nocost-help').hidden = !anyNoCost;
    $('notices').innerHTML = notices.map(n => '<div class="notice ' + n.cls + '">' + n.html + '</div>').join('');
    updateCostMessages();
  }

  /* ---------- Controls ---------- */

  function copyText(text, button) {
    const done = () => { const old = button.textContent; button.textContent = 'Copied'; setTimeout(() => { button.textContent = old; }, 1400); };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { if (document.execCommand('copy')) done(); } catch (e) { /* leave the value on screen to select by hand */ }
      document.body.removeChild(ta);
    };
    try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
  }

  document.addEventListener('click', e => {
    const btn = e.target.closest('button[data-copy]');
    if (!btn) return;
    const which = btn.dataset.copy;
    if (which === 'all') {
      const lines = [];
      if (result.retail != null) lines.push('Retail profit: ' + money(result.retail), 'Services profit: ' + money(result.services));
      if (result.tax != null) lines.push('Total taxable sales: ' + money(result.tax));
      if (state.profit && state.profit.range) lines.push('Profit Report: ' + state.profit.range.from + ' to ' + state.profit.range.to);
      if (state.tax && state.tax.range) lines.push('Sales Tax Report: ' + state.tax.range.from + ' to ' + state.tax.range.to);
      copyText(lines.join('\n'), btn);
    } else if (result[which] != null) {
      copyText(plain(result[which]), btn);
    }
  });

  const fileInput = $('file-input');
  fileInput.addEventListener('change', () => { addFiles(fileInput.files).then(() => { fileInput.value = ''; }); });
  $('choose-label').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  $('choose-label').tabIndex = 0;
  $('choose-label').setAttribute('role', 'button');

  const intake = $('intake');
  ['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); intake.classList.add('over'); }));
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) intake.classList.remove('over'); });
  document.addEventListener('drop', e => { e.preventDefault(); intake.classList.remove('over'); if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });

  const taRetail = $('list-retail'), taServices = $('list-services');
  const fillLists = () => {
    taRetail.value = lists.retail.join('\n');
    taServices.value = lists.services.join('\n');
    fillDeptNames();
  };
  const readLists = () => {
    const parse = v => v.split('\n').map(s => s.trim()).filter(Boolean);
    lists = { retail: parse(taRetail.value), services: parse(taServices.value) };
    store.set('ptt.lists.v2', lists);
    fillDeptNames();
    render();
  };
  taRetail.addEventListener('input', readLists);
  taServices.addEventListener('input', readLists);
  $('reset-lists').addEventListener('click', () => {
    lists = { retail: DEFAULT_RETAIL.slice(), services: DEFAULT_SERVICES.slice() };
    store.set('ptt.lists.v2', lists);
    fillLists();
    render();
  });

  /* ---------- Base costs ---------- */

  /* Accepts 1500, 1500.5, 1,500.00 and $1,500; anything else is flagged rather than guessed at. */
  function parseAmount(text) {
    const t = text.trim().replace(/^\$\s*/, '');
    if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(t)) return null;
    return Math.round(parseFloat(t.replace(/,/g, '')) * 100);
  }

  /* Monthly cents by department key. A department listed twice has its amounts added together. */
  function costsByDept() {
    const out = {};
    costRows.forEach(r => {
      const k = norm(r.name), c = parseAmount(r.amount);
      if (k && c) out[k] = (out[k] || 0) + c;
    });
    return out;
  }

  function costMessage(r, i) {
    const name = r.name.trim(), amount = r.amount.trim();
    if (!name && !amount) return { text: '', bad: false };
    if (amount && parseAmount(amount) == null) return { text: 'Enter the amount as a number, such as 1500 or 1,500.00.', bad: true, field: 'amount' };
    if (!name) return { text: 'Enter the department this cost belongs to.', bad: true, field: 'name' };
    if (!amount) return { text: 'Enter the monthly amount.', bad: true, field: 'amount' };
    const k = norm(name);
    if (costRows.some((o, j) => j < i && norm(o.name) === k)) return { text: name + ' is listed more than once, so its amounts are added together.', bad: false };
    if (!lists.retail.concat(lists.services).some(n => norm(n) === k)) return { text: name + ' is not in the Retail or Services list under Categories, so this cost is not taken off.', bad: false };
    if (state.profit && !state.profit.depts.some(d => norm(d.name) === k)) return { text: name + ' is not on this Profit Report, so this cost is not taken off.', bad: false };
    return { text: '', bad: false };
  }

  const costList = $('cost-rows');

  function saveCosts() { store.set('ptt.costs.v2', costRows.map(r => ({ name: r.name, amount: r.amount }))); }

  /* Messages update in place so typing never rebuilds the row under the cursor. */
  function updateCostMessages() {
    costList.querySelectorAll('.cost-row').forEach(li => {
      const i = Number(li.dataset.i), m = costMessage(costRows[i], i);
      const msg = li.querySelector('.cost-msg');
      msg.textContent = m.text;
      msg.classList.toggle('error', m.bad);
      li.querySelector('.cost-name').setAttribute('aria-invalid', String(m.bad && m.field === 'name'));
      li.querySelector('.cost-amount').setAttribute('aria-invalid', String(m.bad && m.field === 'amount'));
    });
  }

  function costRowEl(r, i) {
    const li = document.createElement('li');
    li.className = 'cost-row';
    li.dataset.i = i;
    const name = document.createElement('input');
    name.type = 'text'; name.className = 'cost-name'; name.value = r.name; name.placeholder = 'Department, e.g. Mailbox Rentals';
    name.setAttribute('list', 'dept-names'); name.setAttribute('aria-label', 'Department'); name.autocomplete = 'off'; name.spellcheck = false;
    const wrap = document.createElement('span');
    wrap.className = 'money-in';
    const sign = document.createElement('span');
    sign.textContent = '$'; sign.setAttribute('aria-hidden', 'true');
    const amount = document.createElement('input');
    amount.type = 'text'; amount.className = 'cost-amount'; amount.value = r.amount; amount.placeholder = '0.00';
    amount.inputMode = 'decimal'; amount.autocomplete = 'off'; amount.setAttribute('aria-label', 'Monthly amount');
    wrap.append(sign, amount);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'btn-small remove'; remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove ' + (r.name || 'this cost'));
    const msg = document.createElement('p');
    msg.className = 'cost-msg'; msg.setAttribute('aria-live', 'polite');
    li.append(name, wrap, remove, msg);
    return li;
  }

  function renderCosts() {
    costList.replaceChildren(...costRows.map(costRowEl));
    if (!costRows.length) {
      const li = document.createElement('li');
      li.className = 'cost-empty';
      li.textContent = 'No base costs. Profit is taken straight from the report.';
      costList.append(li);
    }
    updateCostMessages();
  }

  function fillDeptNames() {
    const names = Array.from(new Set(lists.services.concat(lists.retail)));
    $('dept-names').replaceChildren(...names.map(n => { const o = document.createElement('option'); o.value = n; return o; }));
  }

  costList.addEventListener('input', e => {
    const li = e.target.closest('.cost-row');
    if (!li) return;
    const r = costRows[Number(li.dataset.i)];
    if (e.target.classList.contains('cost-name')) r.name = e.target.value;
    else if (e.target.classList.contains('cost-amount')) r.amount = e.target.value;
    else return;
    li.querySelector('.remove').setAttribute('aria-label', 'Remove ' + (r.name || 'this cost'));
    saveCosts();
    render();
  });
  costList.addEventListener('click', e => {
    const btn = e.target.closest('.remove');
    if (!btn) return;
    costRows.splice(Number(btn.closest('.cost-row').dataset.i), 1);
    saveCosts();
    renderCosts();
    render();
    $('add-cost').focus();
  });
  $('add-cost').addEventListener('click', () => {
    costRows.push({ name: '', amount: '' });
    saveCosts();
    renderCosts();
    costList.querySelector('.cost-row:last-child .cost-name').focus();
  });

  fillLists();
  renderCosts();
  render();
})();
