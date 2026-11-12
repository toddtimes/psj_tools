/* Mailbox Listing and PMB Services Report readers, and the comparison between them. Plain JS, no DOM, so it runs in the page and in Node for testing. */
const PMB = (function () {
  'use strict';

  const ALL_MAILBOXES = 'Includes All Mailboxes';
  const VACANT = 'available';
  const CLOSED_FORWARDING = 'closed and forwarding';
  const KNOWN_STATUSES = new Set([VACANT, 'current', 'past due', 'current and forwarding', CLOSED_FORWARDING]);
  const DATE_TIME = /(\d{1,2}\/\d{1,2}\/\d{4}) \d{1,2}:\d{2}(?::\d{2})?\s*[AP]M/i;

  const clean = s => String(s).replace(/\s+/g, ' ').trim();
  const statusKey = s => clean(s).toLowerCase();
  const shape = t => t.replace(/\d+/g, '#');
  /* The two reports must agree on a box however each prints it: "PMB 099", "#99" and "99" are the same box. */
  const boxKey = s => String(s).trim().toUpperCase().replace(/^(?:PMB|BOX)?\s*#?\s*/, '').replace(/\s+/g, '').replace(/^0+(?=\d)/, '');
  const isBox = s => /^(?:PMB|BOX)?\s*#?\s*[A-Z0-9-]*\d[A-Z0-9-]*$/i.test(clean(s));
  const isNone = s => /^-+\s*NONE\s*-+$/i.test(s);

  function toCents(s) {
    const t = clean(s).replace(/^\$\s*/, '');
    if (!/^-?(\d{1,3}(,\d{3})+|\d+)\.\d\d$/.test(t)) return null;
    return Math.round(parseFloat(t.replace(/,/g, '')) * 100);
  }
  const money = c => '$' + (c / 100).toFixed(2);

  function dnum(s) {
    const p = String(s).split('/').map(Number);
    return p[2] * 10000 + p[0] * 100 + p[1];
  }

  function byBoxOrder(a, b) {
    const na = parseInt(a.box, 10), nb = parseInt(b.box, 10);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    return String(a.box).localeCompare(String(b.box));
  }

  const blank = it => !it.str.trim();

  /* Text is sometimes drawn as several runs on one baseline. Runs that touch are one word, and a gap
     is a space once it is wider than letter-spacing would leave. The yardstick is the page's average
     character width, not the neighbouring run's: a run of wide capitals or of narrow letters would
     move the line either way. A whitespace-only item is the PDF reader's own mark for a word gap, so
     it is always a space. Getting this wrong would turn one name or service into a different one. */
  function join(items, charWidth) {
    const limit = charWidth ? charWidth * 0.3 : 1;
    let text = '';
    let prev = null;
    items.forEach(it => {
      if (blank(it)) { text += ' '; return; }
      if (prev && it.x - (prev.x + (prev.w || 0)) > limit) text += ' ';
      text += it.str;
      prev = it;
    });
    return clean(text);
  }

  /* Group positioned text items into rows: same baseline within 2.5 units, left to right.
     Whitespace-only items never start a row; each joins the row it sits on. */
  function buildRows(items) {
    const all = (items || []).filter(i => i && i.str);
    const inked = all.filter(i => !blank(i));
    const chars = inked.reduce((n, i) => n + i.str.length, 0);
    const charWidth = chars ? inked.reduce((w, i) => w + (i.w || 0), 0) / chars : 0;
    const rows = [];
    inked.sort((a, b) => b.y - a.y || a.x - b.x).forEach(it => {
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.y - it.y) <= 2.5) last.items.push(it);
      else rows.push({ y: it.y, charWidth, items: [it] });
    });
    all.filter(blank).forEach(it => {
      const row = rows.find(r => Math.abs(r.y - it.y) <= 2.5);
      if (row) row.items.push(it);
    });
    rows.forEach(r => {
      /* A space marker can sit at exactly the x of the run after it; it still comes first. */
      r.items.sort((a, b) => a.x - b.x || Number(blank(b)) - Number(blank(a)));
      r.text = join(r.items, r.charWidth);
    });
    return rows;
  }

  /* Column positions are read from each page's heading row instead of being fixed, so a layout that
     shifts is followed, and one that changes beyond recognition is reported rather than misread. */
  const MAILBOX_COLUMNS = [
    { key: 'nbr', re: /^nbr\b/i }, { key: 'type', re: /^size\b/i }, { key: 'status', re: /^status\b/i }, { key: 'customer', re: /^customer\b/i },
    { key: 'closed', re: /^date\b/i }, { key: 'term', re: /^term\b/i }, { key: 'due', re: /^due\b/i }, { key: 'amount', re: /^amount\b/i }
  ];
  const SERVICE_COLUMNS = [
    { key: 'pmb', re: /^pmb\b/i }, { key: 'name', re: /^boxholder\b/i }, { key: 'company', re: /^company\b/i }, { key: 'service', re: /^service\b/i }
  ];

  function headingColumns(row, defs) {
    const cols = [];
    row.items.forEach(it => {
      const d = defs.find(d => d.re.test(clean(it.str)));
      if (d && !cols.some(c => c.key === d.key)) cols.push({ key: d.key, x: it.x });
    });
    return cols.length === defs.length ? cols.sort((a, b) => a.x - b.x) : null;
  }

  /* The Mailbox Listing starts each value at its heading's left edge, give or take a point or two,
     except Amount, which is right-aligned and so starts further right. A value never starts left of
     its own heading, so each column runs from just before its heading to the next one. */
  function leftAligned(cols) {
    return cols.map(c => ({ key: c.key, from: c.x - 8 }));
  }
  /* The PMB Services Report centres its headings over wider columns, so a value starts on either
     side of its heading; halfway between two headings is the dividing line. */
  function centred(cols) {
    return cols.map((c, i) => ({ key: c.key, from: i ? (cols[i - 1].x + c.x) / 2 : -Infinity }));
  }

  function cellsOf(row, cols) {
    const groups = {};
    row.items.forEach(it => {
      let key = 'margin';
      cols.forEach(c => { if (it.x >= c.from) key = c.key; });
      (groups[key] = groups[key] || []).push(it);
    });
    const out = {};
    Object.keys(groups).forEach(k => { const text = join(groups[k], row.charWidth); if (text) out[k] = text; });
    return out;
  }

  /* Splits a page into the rows above its heading row and the rows below. A page with no heading row
     reuses the previous page's columns and drops rows that look like the repeated page header. */
  function splitPage(rows, defs, known, layout) {
    const hi = rows.findIndex(r => headingColumns(r, defs));
    if (hi < 0) return { cols: null, head: rows.filter(r => known.has(shape(r.text))), body: rows.filter(r => !known.has(shape(r.text))) };
    const head = rows.slice(0, hi);
    head.forEach(r => known.add(shape(r.text)));
    return { cols: layout(headingColumns(rows[hi], defs)), head, body: rows.slice(hi + 1) };
  }

  /* pages: one array of { str, x, y, w } text items per page, as PdfReader.readPages returns them */
  function parseMailboxes(pages) {
    const out = { subtitle: null, created: null, pageNumbers: [], boxes: [], amountSum: 0, amountCount: 0, totalDue: null, unread: [], headless: [] };
    const known = new Set();
    let cols = null;
    let last = false; /* whether a mailbox line has been read that a second line could belong to */

    pages.forEach((items, pi) => {
      const page = splitPage(buildRows(items), MAILBOX_COLUMNS, known, leftAligned);
      if (page.cols) cols = page.cols;
      else out.headless.push(pi + 1);

      let pageNumber = null;
      page.head.forEach((r, i) => {
        let m;
        if ((m = r.text.match(/\bPage\s*(\d+)$/i))) pageNumber = +m[1];
        if (!out.created && (m = r.text.match(DATE_TIME))) out.created = m[1];
        const next = page.head[i + 1];
        if (out.subtitle == null && /^Mailbox Listing$/i.test(r.text) && next && !/\bPage\s*\d+$/i.test(next.text) && !DATE_TIME.test(next.text)) out.subtitle = next.text;
      });
      out.pageNumbers.push(pageNumber);

      for (const row of page.body) {
        const t = row.text;
        let m;
        if ((m = t.match(/^Total Amount Due:?\s*(\S+)$/i)) && toCents(m[1]) != null) { out.totalDue = toCents(m[1]); last = false; continue; }
        if (/^Note:/i.test(t)) continue;
        const c = cols ? cellsOf(row, cols) : {};
        if (c.nbr && isBox(c.nbr) && c.status && !c.margin) {
          let customer = c.customer || '';
          /* A long customer name runs into the Term column, and the two arrive as one piece of text. */
          if (!c.term && c.due && (m = customer.match(/^(.*\S)\s+\d+ months?$/i))) customer = m[1];
          out.boxes.push({ box: boxKey(c.nbr), label: c.nbr, type: c.type || '', status: c.status, customer });
          /* An amount that can't be read is left out of the sum, so the check against Total Amount Due reports it. */
          const amount = toCents(c.amount || '');
          if (amount != null) { out.amountSum += amount; out.amountCount++; }
          last = true;
        } else if (last && c.customer && Object.keys(c).length === 1) {
          /* the second line under a customer, usually a phone number; not needed here */
        } else {
          out.unread.push({ page: pi + 1, text: t });
        }
      }
    });
    return out;
  }

  function parseServices(pages) {
    const out = { created: null, pageNumbers: [], pageCount: null, pmbs: [], repeated: [], orphans: [], unread: [], headless: [] };
    const known = new Set();
    const byKey = new Map();
    let cols = null;
    let last = null;
    /* --NONE-- is how the report shows a PMB with no services. A service typed with different
       capitals is the same service; the first spelling seen is the one shown. */
    const spellings = new Map();
    const addService = (e, s) => {
      if (isNone(s)) return;
      const k = s.toLowerCase();
      if (!spellings.has(k)) spellings.set(k, s);
      if (!e.services.includes(spellings.get(k))) e.services.push(spellings.get(k));
    };

    pages.forEach((items, pi) => {
      const page = splitPage(buildRows(items), SERVICE_COLUMNS, known, centred);
      if (page.cols) cols = page.cols;
      else out.headless.push(pi + 1);

      let pageNumber = null;
      page.head.forEach(r => {
        let m;
        if ((m = r.text.match(/\bPage\s*(\d+)\s*of\s*(\d+)\b/i))) { pageNumber = +m[1]; out.pageCount = out.pageCount == null ? +m[2] : Math.max(out.pageCount, +m[2]); }
        if (!out.created && (m = r.text.match(/Report created:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i))) out.created = m[1];
      });
      out.pageNumbers.push(pageNumber);

      let top = true;
      for (const row of page.body) {
        const t = row.text;
        if (/^PMTools report\b/i.test(t)) continue;
        const c = cols ? cellsOf(row, cols) : {};
        if (c.pmb && isBox(c.pmb) && c.service) {
          const key = boxKey(c.pmb);
          const name = c.name || '', company = c.company || '';
          let e = byKey.get(key);
          /* A PMB whose services run over a page break is printed again at the top of the next page.
             The same number anywhere else, or printed differently or under a different name, is a real second entry. */
          const carriedOver = e && top && e === last && e.label === c.pmb && statusKey(e.name) === statusKey(name) && statusKey(e.company) === statusKey(company);
          if (e && !carriedOver) out.repeated.push({ box: c.pmb, first: e.label, page: pi + 1 });
          if (!e) {
            e = { box: key, label: c.pmb, name, company, services: [] };
            byKey.set(key, e);
            out.pmbs.push(e);
          }
          addService(e, c.service);
          last = e;
        } else if (c.service && Object.keys(c).length === 1) {
          if (last) addService(last, c.service);
          else out.orphans.push({ page: pi + 1, text: c.service });
        } else {
          /* Service lines under a line that couldn't be read belong to it, not to the PMB above. */
          out.unread.push({ page: pi + 1, text: t });
          last = null;
        }
        top = false;
      }
    });
    return out;
  }

  /* Which report a PDF is, going by its title rather than its file name. */
  function kindOf(pages) {
    const text = pages.map(items => buildRows(items).map(r => r.text).join('\n')).join('\n');
    if (/PMB Services Report/i.test(text)) return 'services';
    if (/Mailbox Listing/i.test(text)) return 'mailbox';
    return null;
  }

  /* ---------- Checking each report against itself ---------- */

  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const inOrder = nums => nums.every((n, i) => n === i + 1);
  const sample = list => list.slice(0, 6).map(u => u.text).join(' · ') + (list.length > 6 ? ' …' : '');

  /* Notices are { cls, text, list }: plain text, with the affected boxes or lines in list. */
  function mailboxChecks(rep) {
    const out = [];
    if (rep.headless.length) out.push({ cls: 'error', text: 'The column headings were not found on every page of the Mailbox Listing, so some lines may have been misread. Check the lists below against the PDF. Affected pages:', list: rep.headless.join(', ') });
    if (!inOrder(rep.pageNumbers)) out.push({ cls: 'error', text: 'The Mailbox Listing\'s page numbers do not run from 1 upward without a gap, so a page may be missing. Export the report again. Page numbers read:', list: rep.pageNumbers.map(n => n == null ? '?' : n).join(', ') });
    if (rep.totalDue == null) out.push({ cls: 'error', text: 'No "Total Amount Due" line was found at the end of the Mailbox Listing, so the report is probably cut short and boxes may be missing. Export it again.' });
    else if (rep.amountSum !== rep.totalDue) out.push({ cls: 'error', text: 'The amounts read from the Mailbox Listing add up to ' + money(rep.amountSum) + ', but its Total Amount Due line says ' + money(rep.totalDue) + '. A line may have been missed or misread, so check the lists below against the PDF.' });
    if (rep.unread.length) out.push({ cls: 'error', text: plural(rep.unread.length, 'line') + ' in the Mailbox Listing could not be read, so any mailbox on those lines is left out of both lists below. Check them against the PDF:', list: sample(rep.unread) });
    if (!rep.created) out.push({ cls: '', text: 'The date this Mailbox Listing was created could not be found, so there is no check that the two reports are from the same day.' });
    if (statusKey(rep.subtitle || '') !== statusKey(ALL_MAILBOXES)) {
      out.push({ cls: '', text: (rep.subtitle ? 'This Mailbox Listing says "' + rep.subtitle + '"' : 'This Mailbox Listing does not say "' + ALL_MAILBOXES + '"') + ', so it may not list every mailbox and the missing list may be incomplete. Run the report for all mailboxes.' });
    }
    return out;
  }

  function servicesChecks(rep) {
    const out = [];
    const read = rep.pageNumbers.length;
    if (rep.headless.length) out.push({ cls: 'error', text: 'The column headings were not found on every page of the PMB Services Report, so some lines may have been misread. Check the lists below against the PDF. Affected pages:', list: rep.headless.join(', ') });
    if (rep.pageCount == null) out.push({ cls: 'error', text: 'No "Page 1 of …" line was found on the PMB Services Report, so there is no way to tell whether every page was read.' });
    else if (read !== rep.pageCount || !inOrder(rep.pageNumbers)) out.push({ cls: 'error', text: 'The PMB Services Report says it has ' + plural(rep.pageCount, 'page') + ', but ' + (read === rep.pageCount ? 'they are out of order' : read + ' were read') + ', so PMBs may be missing. Export the report again. Page numbers read:', list: rep.pageNumbers.map(n => n == null ? '?' : n).join(', ') });
    if (rep.unread.length) out.push({ cls: 'error', text: plural(rep.unread.length, 'line') + ' in the PMB Services Report could not be read as a PMB or a service, so the boxes on and around those lines may be shown with the wrong services. Check them against the PDF:', list: sample(rep.unread) });
    if (rep.orphans.length) out.push({ cls: 'error', text: plural(rep.orphans.length, 'service line') + ' in the PMB Services Report had no readable PMB line above and could not be given to a box, so a box near each one may wrongly be shown as missing that service:', list: rep.orphans.slice(0, 6).map(o => o.text + ' (page ' + o.page + ')').join(' · ') + (rep.orphans.length > 6 ? ' …' : '') });
    if (rep.repeated.length) out.push({ cls: '', text: 'Listed more than once in the PMB Services Report, away from a page break. The services from every listing were combined. PMB', list: rep.repeated.map(r => r.box + ' (page ' + r.page + (r.first !== r.box ? ', first printed as ' + r.first : '') + ')').join(', ') });
    if (!rep.created) out.push({ cls: '', text: 'The date this PMB Services Report was created could not be found, so there is no check that the two reports are from the same day.' });
    return out;
  }

  /* ---------- Putting the two reports together ---------- */

  function compare(mb, svc) {
    const notices = [];
    const groups = new Map();
    mb.boxes.forEach(b => { if (!groups.has(b.box)) groups.set(b.box, []); groups.get(b.box).push(b); });
    const pmbs = new Map(svc.pmbs.map(p => [p.box, p]));

    const rented = [];
    const vacant = new Set();
    const duplicates = [], relet = [], unknown = [], mismatched = [];
    groups.forEach((rows, key) => {
      const live = rows.filter(r => statusKey(r.status) !== VACANT);
      const forwarding = rows.filter(r => statusKey(r.status) === CLOSED_FORWARDING);
      rows.forEach(r => { if (!KNOWN_STATUSES.has(statusKey(r.status))) unknown.push(r); });
      const printed = Array.from(new Set(rows.map(r => r.label)));
      if (printed.length > 1) {
        /* "05" and "5" are matched as one box so the two reports can agree, but within one report they may be two boxes. */
        mismatched.push(printed.join(' and '));
      } else if (rows.length > 1) {
        /* The report lists a Closed and Forwarding box twice, the second time as it stands now.
           Its own note only mentions Available, but a box that has been rented again shows up the same way. */
        if (rows.length !== 2 || forwarding.length !== 1) duplicates.push(rows[0].label + ' (' + rows.length + ' times)');
        else if (live.length === 2) relet.push(rows[0].label + ' (' + live.find(r => r !== forwarding[0]).status + ')');
      }
      if (!live.length) { vacant.add(key); return; }
      const main = live.find(r => statusKey(r.status) !== CLOSED_FORWARDING) || live[0];
      const p = pmbs.get(key);
      rented.push({
        box: key, label: main.label, customer: main.customer || (p ? p.name : ''), company: p ? p.company : '',
        status: main.status, also: live.filter(r => r !== main).map(r => r.status), type: main.type,
        listed: !!p, services: p ? p.services.slice() : []
      });
    });
    rented.sort(byBoxOrder);

    /* Every service on the report is offered, counted over rented boxes so the count always equals the has-it list. */
    const names = Array.from(new Set(svc.pmbs.flatMap(p => p.services)));
    const services = names.map(name => ({ name, count: rented.filter(r => r.services.includes(name)).length })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const labels = list => list.slice().sort(byBoxOrder).map(e => e.label).join(', ');
    const notInMailbox = svc.pmbs.filter(p => !groups.has(p.box));
    const vacantWithServices = svc.pmbs.filter(p => vacant.has(p.box));
    const unlisted = rented.filter(r => !r.listed);

    if (mb.created && svc.created && dnum(mb.created) !== dnum(svc.created)) notices.push({ cls: '', text: 'The two reports were created on different dates: Mailbox Listing ' + mb.created + ', PMB Services Report ' + svc.created + '. Export both on the same day so they describe the same boxes.' });
    if (mismatched.length) notices.push({ cls: '', text: 'The Mailbox Listing prints these box numbers differently, but they are treated as one box because only a prefix or leading zeros differ. If they are separate boxes, the results for them are wrong. Box', list: mismatched.join(', ') });
    if (duplicates.length) notices.push({ cls: '', text: 'Listed more than once on the Mailbox Listing. Each is counted once. Box', list: duplicates.join(', ') });
    if (relet.length) notices.push({ cls: 'info', text: 'Listed on the Mailbox Listing both as Closed and Forwarding and under a current customer. Each is counted once, under the current customer. Box', list: relet.join(', ') });
    if (unknown.length) notices.push({ cls: '', text: 'The Mailbox Listing has statuses this tool does not know (' + Array.from(new Set(unknown.map(r => r.status))).join(', ') + '). Those boxes are counted as rented. Box', list: labels(unknown) });
    if (notInMailbox.length) notices.push({ cls: '', text: 'In the PMB Services Report but not on the Mailbox Listing, so left out of both lists. PMB', list: labels(notInMailbox) });
    if (vacantWithServices.length) notices.push({ cls: '', text: 'In the PMB Services Report, but the Mailbox Listing shows the box as Available, so left out of both lists. PMB', list: labels(vacantWithServices) });
    if (unlisted.length) notices.push({ cls: '', text: 'Rented, but not in the PMB Services Report at all, so counted as missing every service. Box', list: labels(unlisted) });

    return { rented, services, vacantCount: vacant.size, notices };
  }

  /* Rented boxes with and without one service. A box marked --NONE-- or absent from the services report is missing every service. */
  function find(cmp, service) {
    return {
      has: cmp.rented.filter(r => r.services.includes(service)),
      missing: cmp.rented.filter(r => !r.services.includes(service))
    };
  }

  /* A list as tab-separated text, so it pastes into a spreadsheet as columns. Report text is untrusted:
     a tab or line break inside a value would shift the columns, and a value starting with = + - or @
     would be run as a formula, so those get a leading apostrophe, which spreadsheets read as "plain text". */
  function listText(rows) {
    const cell = v => { const t = clean(v); return /^[=+\-@]/.test(t) ? "'" + t : t; };
    const services = r => !r.listed ? 'Not in the services report' : r.services.length ? r.services.join(', ') : 'None';
    return ['Box\tCustomer\tCompany\tStatus\tSize/Type\tServices on the box']
      .concat(rows.map(r => [r.label, r.customer, r.company, [r.status].concat(r.also).join(' / '), r.type, services(r)].map(cell).join('\t')))
      .join('\n');
  }

  return { parseMailboxes, parseServices, kindOf, mailboxChecks, servicesChecks, compare, find, listText, boxKey, money };
})();
if (typeof module !== 'undefined') module.exports = PMB;


(function () {
  'use strict';

  const SERVICE_KEY = 'psf.service.v1';
  const TITLES = { mailbox: 'Mailbox Listing', services: 'PMB Services Report' };

  const state = { mailbox: null, services: null, errors: [] };
  let cmp = null;
  let result = null;

  const $ = id => document.getElementById(id);
  const esc = Site.esc;
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

  /* ---------- Reading the PDFs ---------- */

  async function addFiles(fileList) {
    const files = Array.from(fileList || []).filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    state.errors = [];
    if (!files.length) { state.errors.push('Those files are not PDFs. Add the Mailbox Listing and the PMB Services Report as PDFs.'); render(); return; }
    const added = {};
    for (const file of files) {
      try {
        const pages = await PdfReader.readPages(file);
        if (!pages.some(p => p.some(i => i.str && i.str.trim()))) { state.errors.push(file.name + ' has no readable text. It may be a scan; export the report as a PDF from PostalMate instead.'); continue; }
        const kind = PMB.kindOf(pages);
        if (!kind) { state.errors.push(file.name + ' is not a Mailbox Listing or a PMB Services Report.'); continue; }
        const rep = kind === 'mailbox' ? PMB.parseMailboxes(pages) : PMB.parseServices(pages);
        rep.fileName = file.name;
        if (kind === 'mailbox' && !rep.boxes.length) { state.errors.push(file.name + ' looks like a Mailbox Listing, but no mailboxes could be read from it.'); continue; }
        if (kind === 'services' && !rep.pmbs.length) { state.errors.push(file.name + ' looks like a PMB Services Report, but no PMBs could be read from it.'); continue; }
        if (added[kind]) state.errors.push(added[kind] + ' and ' + file.name + ' are both a ' + TITLES[kind] + '. ' + file.name + ' is the one being used.');
        added[kind] = file.name;
        state[kind] = rep;
      } catch (e) {
        state.errors.push(file.name + ' could not be read. ' + (e && e.message ? e.message : ''));
      }
    }
    render();
  }

  /* ---------- Showing it ---------- */

  function slotHtml(kind, rep) {
    if (!rep) return '<span class="label">' + TITLES[kind] + '</span><span class="file">Not added yet</span><span class="state">Waiting for this report</span>';
    const what = kind === 'mailbox' ? plural(rep.boxes.length, 'mailbox line') : plural(rep.pmbs.length, 'PMB');
    const bits = [what, plural(rep.pageNumbers.length, 'page'), rep.created ? 'created ' + rep.created : 'date not found'];
    return '<span class="label">' + TITLES[kind] + '</span><span class="file">' + esc(rep.fileName) + '</span><span class="state">' + esc(bits.join(' · ')) + '</span>';
  }

  const noticeHtml = n => '<div class="notice ' + n.cls + '">' + (n.html || esc(n.text) + (n.list ? ' <strong>' + esc(n.list) + '</strong>' : '')) + '</div>';

  /* The picker is rebuilt only when a report changes, so choosing a service never resets it. */
  function fillPicker() {
    const select = $('service');
    const current = select.value;
    const saved = Site.store.get(SERVICE_KEY, null);
    const names = cmp ? cmp.services.map(s => s.name) : [];
    const options = cmp && names.length
      ? cmp.services.map(s => { const o = document.createElement('option'); o.value = s.name; o.textContent = s.name + ' (' + plural(s.count, 'box', 'boxes') + ')'; return o; })
      : [Object.assign(document.createElement('option'), { value: '', textContent: cmp ? 'No services on this report' : 'Add both reports' })];
    select.replaceChildren(...options);
    select.disabled = !names.length;
    /* Keep what is showing if it is still on offer (saving may be blocked), then the saved choice.
       cmp.services is sorted most common first, so that is the default. */
    select.value = [current, saved].find(n => names.includes(n)) || names[0] || '';
  }

  function statusHtml(r) {
    const plain = /^current$/i.test(r.status);
    return '<span class="status' + (plain ? '' : ' flag') + '">' + esc(r.status) + '</span>' +
      r.also.map(s => '<br><span class="tag">also listed as ' + esc(s) + '</span>').join('');
  }

  function servicesHtml(r) {
    if (!r.listed) return '<span class="tag">Not in the services report</span>';
    if (!r.services.length) return '<span class="tag">None</span>';
    return r.services.map(s => '<span class="svc">' + esc(s) + '</span>').join('');
  }

  /* On a phone the stylesheet turns each row into a card, which makes browsers drop the table's
     meaning for screen readers unless the roles are spelled out. data-label is the heading shown
     beside a value once the column headings are gone. */
  function ledgerHtml(which, title, rows, service, emptyText) {
    const body = rows.map(r => '<tr role="row"><td role="cell" class="box">' + esc(r.label) + '</td>' +
      '<td role="cell" class="who">' + esc(r.customer || '—') + (r.company ? '<br><span class="tag">' + esc(r.company) + '</span>' : '') + '</td>' +
      '<td role="cell" class="status-cell" data-label="Status">' + statusHtml(r) + '</td>' +
      '<td role="cell" class="type"' + (r.type ? ' data-label="Size/Type"' : '') + '>' + esc(r.type) + '</td>' +
      '<td role="cell" class="services" data-label="Services">' + servicesHtml(r) + '</td></tr>').join('') ||
      '<tr role="row" class="empty-row"><td role="cell" colspan="5">' + emptyText + '</td></tr>';
    const heads = ['Box', 'Customer', 'Status', 'Size/Type', 'Services on the box'].map(h => '<th role="columnheader">' + h + '</th>').join('');
    return '<div class="ledger-head"><h2>' + title + ' ' + esc(service) + '</h2><span class="actions"><span class="muted">' + plural(rows.length, 'box', 'boxes') + '</span>' +
      '<button class="btn-small" type="button" data-copy="' + which + '-boxes"' + (rows.length ? '' : ' disabled') + '>Copy box numbers</button>' +
      '<button class="btn-small" type="button" data-copy="' + which + '-list"' + (rows.length ? '' : ' disabled') + '>Copy list</button></span></div>' +
      '<div class="scroll"><table role="table"><thead role="rowgroup"><tr role="row">' + heads + '</tr></thead><tbody role="rowgroup">' + body + '</tbody></table></div>';
  }

  function renderResults() {
    const service = cmp ? $('service').value : '';
    const pending = (id, sub) => { $('val-' + id).textContent = '—'; $('val-' + id).classList.add('pending'); $('sub-' + id).textContent = sub; };
    const show = (id, n, sub) => { $('val-' + id).textContent = n; $('val-' + id).classList.remove('pending'); $('sub-' + id).textContent = sub; };

    $('summary').textContent = '';
    if (!cmp) {
      result = null;
      const waiting = !state.mailbox && !state.services ? 'Add both reports' : 'Add the ' + TITLES[state.mailbox ? 'services' : 'mailbox'];
      ['missing', 'has', 'rented'].forEach(id => pending(id, waiting));
      $('ledger-missing').innerHTML = '';
      $('ledger-has').innerHTML = '';
      return;
    }

    show('rented', cmp.rented.length, plural(cmp.vacantCount, 'available box', 'available boxes') + ' left out');
    if (!service) {
      result = null;
      ['missing', 'has'].forEach(id => pending(id, 'No services on this report'));
      $('ledger-missing').innerHTML = '';
      $('ledger-has').innerHTML = '';
      return;
    }
    const found = PMB.find(cmp, service);
    result = { service, missing: found.missing, has: found.has };
    show('missing', found.missing.length, 'Rented boxes without ' + service);
    show('has', found.has.length, 'Rented boxes with ' + service);
    /* One sentence for screen readers to announce when the service changes, rather than bare numbers. */
    $('summary').textContent = found.missing.length + ' of ' + plural(cmp.rented.length, 'rented box', 'rented boxes') + (found.missing.length === 1 ? ' is' : ' are') + ' missing ' + service + '; ' + found.has.length + (found.has.length === 1 ? ' has' : ' have') + ' it.';
    $('ledger-missing').innerHTML = ledgerHtml('missing', 'Missing', found.missing, service, 'Every rented box has this service.');
    $('ledger-has').innerHTML = ledgerHtml('has', 'Has', found.has, service, 'No rented box has this service.');
  }

  function render() {
    const mb = state.mailbox, svc = state.services;
    const notices = state.errors.map(e => ({ cls: 'error', text: e }));

    $('slot-mailbox').className = 'slot ' + (mb ? 'ready' : 'empty');
    $('slot-mailbox').innerHTML = slotHtml('mailbox', mb);
    $('slot-services').className = 'slot ' + (svc ? 'ready' : 'empty');
    $('slot-services').innerHTML = slotHtml('services', svc);

    const mbNotes = mb ? PMB.mailboxChecks(mb) : [];
    const svcNotes = svc ? PMB.servicesChecks(svc) : [];
    cmp = mb && svc ? PMB.compare(mb, svc) : null;
    notices.push(...mbNotes, ...svcNotes, ...(cmp ? cmp.notices : []));
    if (!cmp && (mb || svc)) notices.push({ cls: 'info', html: 'Now add the <strong>' + TITLES[mb ? 'services' : 'mailbox'] + '</strong> to see which boxes have each service.' });

    /* Say exactly what was checked and no more, so a clean result is visibly a checked one, and never when a check failed.
       The dates are here too because a printout drops the report slots above. */
    const failed = list => list.some(n => n.cls === 'error');
    const made = rep => rep.created ? ', created ' + rep.created : '';
    const line = [];
    if (mb) line.push('Mailbox Listing' + made(mb) + ': read ' + plural(mb.boxes.length, 'mailbox line') + ' on ' + plural(mb.pageNumbers.length, 'page') + (failed(mbNotes) ? ', with the problems listed above.' : '; the ' + plural(mb.amountCount, 'amount') + ' due on it add up to its Total Amount Due of ' + PMB.money(mb.totalDue) + '.'));
    if (svc) line.push('PMB Services Report' + made(svc) + ': read ' + plural(svc.pmbs.length, 'PMB') + (failed(svcNotes) ? ', with the problems listed above.' : ' on ' + plural(svc.pageCount, 'page') + ', the number the report says it has.'));
    $('check-line').textContent = line.join(' ');

    fillPicker();
    renderResults();
    $('notices').innerHTML = notices.map(noticeHtml).join('');
  }

  /* ---------- Controls ---------- */

  function copyText(text, button) {
    const done = () => { const old = button.textContent; button.textContent = 'Copied'; setTimeout(() => { button.textContent = old; }, 1400); };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { if (document.execCommand('copy')) done(); } catch (e) { /* leave the list on screen to select by hand */ }
      document.body.removeChild(ta);
    };
    try { navigator.clipboard.writeText(text).then(done, fallback); } catch (e) { fallback(); }
  }

  document.addEventListener('click', e => {
    const btn = e.target.closest('button[data-copy]');
    if (!btn || !result) return;
    const [which, form] = btn.dataset.copy.split('-');
    const rows = result[which];
    if (!rows) return;
    copyText(form === 'boxes' ? rows.map(r => r.label).join(', ') : PMB.listText(rows), btn);
  });

  $('service').addEventListener('change', () => {
    if (!cmp) return;
    Site.store.set(SERVICE_KEY, $('service').value);
    renderResults();
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

  render();
})();
