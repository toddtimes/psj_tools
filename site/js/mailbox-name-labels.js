/* Mailbox Name Labels: report parsing and label layout. Pure functions, no DOM. */
var MNL = (function () {
  'use strict';

  /* ---------- Label stock: positions measured from each template PDF (inches, Letter) ---------- */
  var SHEET = { w: 8.5, h: 11 };
  function stock(id, name, size, label, cols, rows) {
    var slots = [];
    rows.forEach(function (y) { cols.forEach(function (x) { slots.push({ x: x, y: y }); }); });
    return { id: id, name: name, size: size, label: label, cols: cols.length, slots: slots, perSheet: slots.length };
  }
  var STOCKS = {
    royal8: stock('royal8', '8 per sheet', '3⅜ × 2⅓ in',
      { w: 3.4125, h: 2.3365, r: 0.13 }, [0.67, 4.4176], [0.5952, 3.0862, 5.5773, 8.0683]),
    avery5164: stock('avery5164', 'Avery 5164', '4 × 3⅓ in',
      { w: 4.0, h: 3.3333, r: 0.19 }, [0.1556, 4.3437], [0.5, 3.8326, 7.166])
  };
  var DEFAULT_STOCK = 'royal8';
  function getStock(s) {
    if (s && typeof s === 'object' && s.label) return s;
    return STOCKS[s] || STOCKS[DEFAULT_STOCK];
  }

  /* ---------- Report parsing ---------- */
  var DATE_RE = /(\d{1,2}\/\d{1,2}\/\d{4})/;
  var KNOWN_STATUS = ['Current and Forwarding', 'Closed and Forwarding', 'Past Due and Forwarding',
    'Past Due', 'Current', 'Closed', 'Forwarding', 'Pending', 'Suspended', 'Inactive', 'On Hold'];
  var TRAIL_STATUS_RE = /^(.*?\S)\s*((?:[A-Z][a-z]+)(?:\s+(?:[A-Z][a-z]+|and|or))*)\s*$/;

  function squash(s) { return String(s).replace(/\s+/g, ' ').trim(); }
  function cleanName(s) { return squash(s).replace(/^[_\s]+/, ''); }

  function joinRun(items) {
    var out = '', lastEnd = null;
    items.forEach(function (it) {
      if (!it.str.trim()) return;
      if (out && lastEnd !== null && it.x - lastEnd > 1.2 && !/\s$/.test(out)) out += ' ';
      out += it.str;
      lastEnd = it.x + it.w;
    });
    return squash(out);
  }

  function splitTrailingStatus(name) {
    for (var i = 0; i < KNOWN_STATUS.length; i++) {
      var st = KNOWN_STATUS[i];
      if (name.length > st.length && name.slice(-st.length) === st) {
        return { name: name.slice(0, -st.length).trim(), status: st };
      }
    }
    var m = name.match(TRAIL_STATUS_RE);
    if (m && /[A-Z]{2}|\d|[^A-Za-z\s]/.test(m[1])) return { name: m[1].trim(), status: m[2] };
    return { name: name, status: '' };
  }

  function findHeader(items) {
    function find(re) { for (var i = 0; i < items.length; i++) if (re.test(items[i].str.trim())) return items[i]; return null; }
    var name = find(/^Mailname$/i), status = find(/^Status$/i);
    if (!name || !status) return null;
    var due = find(/^Due(\s*Date)?$/i), notes = find(/^Notes$/i), nbr = find(/^Nbr$/i);
    var dueX = due ? due.x : status.x + 97;
    return {
      y: name.y,
      nbrX: nbr ? nbr.x : name.x - 21,
      nameX: name.x,
      statusX: status.x,
      dueX: dueX,
      notesX: notes ? notes.x : dueX + 135
    };
  }

  /* pages: [{ items: [{ str, x, y, w }] }] in PDF units (y grows upward). */
  function parseReport(pages) {
    var rows = [], cols = null, store = [], printed = '', warnings = [];

    pages.forEach(function (page, pi) {
      var items = page.items.filter(function (it) { return it.str && it.str.trim(); });
      var head = findHeader(items);
      if (head) cols = head;
      if (!cols) return;
      var headY = head ? head.y : Infinity;

      if (pi === 0) {
        items.forEach(function (it) {
          var m = it.str.match(/\d{1,2}\/\d{1,2}\/\d{4}\s+\d{1,2}:\d{2}\s*[AP]M/i);
          if (m && it.y > headY) printed = m[0];
        });
        store = items.filter(function (it) { return it.x < cols.nameX + 60 && it.y > headY + 5; })
          .sort(function (a, b) { return b.y - a.y; })
          .map(function (it) { return squash(it.str); });
      }

      var body = items.filter(function (it) { return it.y < headY - 3; })
        .sort(function (a, b) { return b.y - a.y || a.x - b.x; });
      var groups = [];
      body.forEach(function (it) {
        var g = groups[groups.length - 1];
        if (g && Math.abs(g.y - it.y) <= 2.5) g.items.push(it);
        else groups.push({ y: it.y, items: [it] });
      });

      groups.forEach(function (g) {
        var cells = { nbr: [], name: [], status: [], due: [], notes: [] };
        g.items.sort(function (a, b) { return a.x - b.x; }).forEach(function (it) {
          var x = it.x;
          if (x < cols.nameX - 2) cells.nbr.push(it);
          else if (x < cols.statusX - 2) cells.name.push(it);
          else if (x < cols.dueX - 2) cells.status.push(it);
          else if (x < cols.notesX - 2) cells.due.push(it);
          else cells.notes.push(it);
        });
        rows.push({
          page: pi + 1,
          nbr: joinRun(cells.nbr), name: joinRun(cells.name), status: joinRun(cells.status),
          due: joinRun(cells.due), notes: joinRun(cells.notes)
        });
      });
    });

    if (!cols) return { error: 'This PDF has no Nbr / Mailname / Status columns. Load the Mailnames Report.' };

    var entries = [], last = null;
    rows.forEach(function (r) {
      var nbr = '', name = r.name, status = r.status, due = r.due, notes = r.notes;
      var m = r.nbr.match(/^(\d+)\s*(.*)$/);
      if (m) { nbr = m[1]; if (m[2]) name = squash(m[2] + ' ' + name); }
      else if (r.nbr) return; /* footer or stray text in the number column */

      if (!nbr) {
        if (last && name && !status && !due) last.raw = squash(last.raw + ' ' + name);
        return;
      }
      if (!status) { var sp = splitTrailingStatus(name); name = sp.name; status = sp.status; }
      if (!DATE_RE.test(due)) {
        var pool = [status, notes].join(' ');
        var dm = pool.match(DATE_RE);
        if (dm) { due = dm[1]; status = squash(status.replace(DATE_RE, '')); notes = squash(notes.replace(DATE_RE, '')); }
      } else {
        var dd = due.match(DATE_RE);
        var extra = squash(due.replace(DATE_RE, ''));
        due = dd[1];
        if (extra) notes = squash(extra + ' ' + notes);
      }
      last = { nbr: Number(nbr), raw: cleanName(name), status: status, due: due, notes: notes, page: r.page };
      if (!last.status) warnings.push('Box ' + nbr + ': no status read for ' + last.raw);
      entries.push(last);
    });

    /* "SMITH, JANE – ACME LLC" becomes two entries, SMITH, JANE and ACME LLC. A name that appears
       more than once in a box (a business shared by several people) is listed once; if any of its
       report lines is open, the entry takes that line's status. */
    var byNbr = new Map();
    entries.forEach(function (e) {
      if (!e.raw) return;
      if (!byNbr.has(e.nbr)) byNbr.set(e.nbr, { nbr: e.nbr, names: [], seen: new Map() });
      var box = byNbr.get(e.nbr);
      splitEntry(e.raw).forEach(function (part) {
        var key = part.text.toUpperCase().replace(/[^A-Z0-9&#]+/g, ' ').trim();
        var prev = box.seen.get(key);
        if (prev) {
          if (isClosed(prev.status) && !isClosed(e.status)) { prev.status = e.status; prev.due = e.due; }
          return;
        }
        var n = { raw: part.text, business: part.business, status: e.status, due: e.due, notes: e.notes };
        box.seen.set(key, n);
        box.names.push(n);
      });
    });
    var boxes = Array.from(byNbr.values()).sort(function (a, b) { return a.nbr - b.nbr; });
    boxes.forEach(function (b) {
      delete b.seen;
      /* People first, then businesses, each in report order. */
      b.names = b.names.filter(function (n) { return !n.business; })
        .concat(b.names.filter(function (n) { return n.business; }));
      var open = b.names.filter(function (n) { return !isClosed(n.status); });
      var ref = open[0] || b.names[0];
      b.status = ref.status;
      b.due = ref.due;
      b.notes = Array.from(new Set(b.names.map(function (n) { return n.notes; }).filter(Boolean))).join(' · ');
    });

    return {
      store: store.filter(function (s) { return !/^(Page|Version)\b/i.test(s); }).slice(0, 3),
      printed: printed,
      boxes: boxes,
      nameCount: entries.length,
      warnings: warnings
    };
  }

  function isClosed(status) { return /^closed/i.test(status || ''); }

  /* Splits at a dash with spaces around it (en dash, em dash or hyphen). Hyphenated names
     like FUEHR-BUSH have no spaces and stay whole. Parts after the first are businesses. */
  var SEP_RE = /\s+[–—-]\s+/;
  function splitEntry(raw) {
    var out = [];
    raw.split(SEP_RE).forEach(function (p, i) {
      p = cleanName(p);
      if (p) out.push({ text: p, business: i > 0 || !looksLikePerson(p) });
    });
    return out;
  }

  /* The report writes people as "LAST, FIRST". Anything without that comma, or with an
     entity word in it (LLC, Inc, Trust, Estate...), is treated as a business. */
  var ENTITY_RE = /\b(L\.?L\.?C|P\.?L\.?L\.?C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LLP|LP|TRUST|TRUSTEE|ESTATE|FOUNDATION|ASSOCIATION|ASSN|HOA|HOMEOWNERS|OWNERS|CONDOMINIUM|CONDO|GROUP|HOLDINGS|PROPERTIES|PARTNERS|SERVICES|ENTERPRISES|CLUB|SOCIETY|FUND|INSTITUTE|NETWORK)\b/;
  function looksLikePerson(text) {
    var t = String(text).toUpperCase();
    return t.indexOf(',') !== -1 && !ENTITY_RE.test(t);
  }

  /* ---------- Name styles ---------- */
  function firstLast(s) {
    var m = s.match(/^(.*?)(\s+[–—-]\s+)(.*)$/);
    var person = m ? m[1] : s, rest = m ? m[2] + m[3] : '';
    var c = person.split(',');
    if (c.length === 2 && c[0].trim() && c[1].trim()) person = c[1].trim() + ' ' + c[0].trim();
    return person + rest;
  }

  /* ---------- Label layout ----------
     measure(text, sizePt, bold) -> width in inches.
     A box's names are set one per line in a single size between the smallest size allowed
     (opts.minPt, MIN_PT by default, never below MIN_PT_FLOOR) and MAX_PT. When they don't fit
     on one label at that size they run onto extra labels, which carry no box number.
     Layout works in the label's own frame, W x H, which is turned 90 degrees when rot is set;
     runs carry x, y (text baseline) in inches in that frame, and toLabel() maps a point back
     onto the label as it sits on the sheet. */
  var PAD_X = 0.19, PAD_TOP = 0.17, PAD_BOTTOM = 0.15;
  var NUM_PT = 19, MAX_PT = 12, MIN_PT = 10.5, MIN_PT_FLOOR = 6, STEP = 0.25, INDENT = 0.13;
  var LEAD = 1.2, NAME_GAP = 0.22;  /* line height and extra space between names, in ems */
  var CAP = 0.718;                  /* Helvetica cap height, in ems */
  var HEAD_GAP = 0.12;              /* space between the box number and the last names, inches */
  var RULE_BELOW = 0.075, RULE_ABOVE = 0.085;

  /* Greedy word wrap. firstW is the first line's width, restW every later line's. */
  function wrapWords(text, firstW, restW, sizePt, measure) {
    var words = text.split(' '), lines = [], line = '';
    for (var i = 0; i < words.length; i++) {
      var word = words[i];
      var avail = lines.length ? restW : firstW;
      var trial = line ? line + ' ' + word : word;
      if (measure(trial, sizePt) <= avail) { line = trial; continue; }
      if (!line) return null; /* a single word wider than the column */
      lines.push(line);
      line = word;
      if (measure(line, sizePt) > restW) return null;
    }
    if (line) lines.push(line);
    return lines;
  }

  /* Wraps a name, preferring to break after a dash. Falls back to breaking anywhere for a
     word too wide for the label. */
  function wrap(text, width, sizePt, measure) {
    var greedy = wrapWords(text, width, width - INDENT, sizePt, measure);
    if (!greedy) return hardWrap(text, width, sizePt, measure);
    if (greedy.length < 2) return greedy;
    var m = text.match(/^(.*?\s[–—-])\s+(.*)$/);
    if (!m) return greedy;
    var head = wrapWords(m[1], width, width - INDENT, sizePt, measure);
    var tail = wrapWords(m[2], width - INDENT, width - INDENT, sizePt, measure);
    if (head && tail && head.length + tail.length <= greedy.length) return head.concat(tail);
    return greedy;
  }

  function hardWrap(text, width, sizePt, measure) {
    var lines = [], line = '';
    Array.from(text).forEach(function (ch) {
      var avail = lines.length ? width - INDENT : width;
      if (!line || measure(line + ch, sizePt) <= avail) line += ch;
      else { lines.push(line.trim()); line = ch.trim(); }
    });
    if (line) lines.push(line);
    return lines;
  }

  /* Fills labels in order at one size. h1 is the name area on the first label, h2 on the rest. */
  function pack(names, size, width, h1, h2, measure) {
    var lh = size * LEAD / 72, gap = size * NAME_GAP / 72;
    var parts = [[]], used = 0, avail = h1, over = false;
    names.forEach(function (name) {
      var lines = wrap(name, width, size, measure), h = lines.length * lh;
      var cur = parts[parts.length - 1], need = cur.length ? used + gap + h : h;
      if (need > avail + 1e-6 && cur.length) {
        cur = []; parts.push(cur); avail = h2; need = h;
      }
      if (need > avail + 1e-6) over = true; /* one name taller than a whole label */
      cur.push(lines);
      used = need;
    });
    return { parts: parts, over: over };
  }

  /* Up to two last names beside the box number: both at the largest size that fits, else the
     first alone, else the first cut short. */
  function fitHeadNames(names, sep, width, minPt, measure) {
    var tries = [names.slice(0, 2).join(' ' + sep + ' ')];
    if (names.length > 1) tries.push(names[0]);
    for (var t = 0; t < tries.length; t++) {
      for (var s = NUM_PT; s >= minPt - 1e-9; s -= 0.5) {
        if (measure(tries[t], s, true) <= width) return { text: tries[t], size: s };
      }
    }
    var text = names[0];
    while (text.length > 1 && measure(text + '…', minPt, true) > width) text = text.slice(0, -1);
    return text.length > 1 ? { text: text.trim() + '…', size: minPt } : null;
  }

  /* The smallest size names may shrink to, clamped to a sane range in half-point steps. */
  function minPtOf(opts) {
    var v = Number(opts && opts.minPt);
    if (!isFinite(v)) return MIN_PT;
    return Math.round(Math.max(MIN_PT_FLOOR, Math.min(MAX_PT, v)) * 2) / 2;
  }

  /* Box number (and last names) as one line flush left, at the top or bottom, with a rule
     between it and the names. Returns the runs and the name area left over. */
  function headRuns(nbr, opts, W, H, measure) {
    var num = String(nbr), numW = measure(num, NUM_PT, true), capH = NUM_PT * CAP / 72;
    var availW = W - PAD_X * 2;
    var names = (opts.lastNames || []).filter(Boolean);
    var tail = names.length ? fitHeadNames(names, opts.sep || '&', availW - numW - HEAD_GAP, minPtOf(opts), measure) : null;
    var x = PAD_X; /* flush left, so the number sits in the same spot on every label */
    var bottom = !!opts.numberAtBottom;
    var base = bottom ? H - PAD_BOTTOM : PAD_TOP + capH;
    var runs = [{ kind: 'num', text: num, x: x, y: base, size: NUM_PT, bold: true }];
    if (tail) runs.push({ kind: 'head', text: tail.text, x: x + numW + HEAD_GAP, y: base, size: tail.size, bold: true });
    var ruleY = bottom ? base - capH - RULE_ABOVE : base + RULE_BELOW;
    runs.push({ kind: 'rule', x: PAD_X, y: ruleY, w: availW });
    return {
      runs: runs,
      top: bottom ? PAD_TOP : ruleY + RULE_ABOVE,
      bottom: bottom ? ruleY - RULE_BELOW : H - PAD_BOTTOM
    };
  }

  /* opts: { stock, showNumber, numberAtBottom, lastNames: [..], sep, rotate: 0 | 90 | -90, minPt }
     rotate 90 turns the text clockwise (reads downward), -90 counter-clockwise (reads upward). */
  function layoutBox(nbr, names, opts, measure) {
    var LABEL = getStock(opts.stock).label;
    var rot = opts.rotate === 90 || opts.rotate === -90 ? opts.rotate : 0;
    var W = rot ? LABEL.h : LABEL.w, H = rot ? LABEL.w : LABEL.h, width = W - PAD_X * 2;
    var head = opts.showNumber ? headRuns(nbr, opts, W, H, measure) : null;
    var top1 = head ? head.top : PAD_TOP;
    var h1 = (head ? head.bottom : H - PAD_BOTTOM) - top1, h2 = H - PAD_TOP - PAD_BOTTOM;
    var base = { rot: rot, W: W, H: H };
    if (!names.length) return Object.assign(base, { size: 0, fits: true, empty: true, parts: [{ runs: head ? head.runs : [], count: 0 }] });

    /* Fewest labels the names need at the smallest size, then the largest size that keeps that count. */
    var minPt = minPtOf(opts);
    var need = pack(names, minPt, width, h1, h2, measure).parts.length, size = minPt, packed = null;
    for (var s = MAX_PT; s >= minPt - 1e-9; s -= STEP) {
      var p = pack(names, s, width, h1, h2, measure);
      if (p.parts.length <= need) { size = s; packed = p; break; }
    }
    var lh = size * LEAD / 72, gap = size * NAME_GAP / 72, asc = size * CAP / 72;
    var parts = packed.parts.map(function (group, pi) {
      var runs = pi === 0 && head ? head.runs.slice() : [];
      var y = (pi === 0 ? top1 : PAD_TOP) + asc;
      group.forEach(function (lines, ni) {
        lines.forEach(function (line, li) {
          runs.push({ kind: 'name', text: line, x: PAD_X + (li ? INDENT : 0), y: y, size: size, bold: false });
          y += lh;
        });
        if (ni < group.length - 1) y += gap;
      });
      return { runs: runs, count: group.length };
    });
    return Object.assign(base, { size: size, fits: !packed.over, parts: parts });
  }

  /* Maps a point in the label's own (possibly turned) frame to the label's frame on the sheet. */
  function toLabel(x, y, rot, stockOrId) {
    var LABEL = getStock(stockOrId).label;
    if (rot === 90) return { x: LABEL.w - y, y: x };
    if (rot === -90) return { x: y, y: LABEL.h - x };
    return { x: x, y: y };
  }

  /* Last name of a "LAST, FIRST" entry, or the last word of a name written "FIRST LAST". */
  function lastNameOf(text) {
    var t = String(text).replace(/\s+/g, ' ').trim();
    if (!t) return '';
    var c = t.indexOf(',');
    if (c > 0) return t.slice(0, c).trim();
    var w = t.split(' ');
    return w[w.length - 1];
  }

  /* Places labels on sheets. start is the first free label on the first sheet, counting from 1. */
  function paginate(count, start, perSheet) {
    var n = perSheet || 8;
    var out = [], slot = Math.max(0, Math.min(n - 1, (start || 1) - 1)), sheet = 0;
    for (var i = 0; i < count; i++) {
      out.push({ sheet: sheet, slot: slot });
      slot++;
      if (slot > n - 1) { slot = 0; sheet++; }
    }
    return out;
  }

  return {
    SHEET: SHEET, STOCKS: STOCKS, DEFAULT_STOCK: DEFAULT_STOCK, getStock: getStock,
    parseReport: parseReport, isClosed: isClosed, firstLast: firstLast, cleanName: cleanName, splitEntry: splitEntry, looksLikePerson: looksLikePerson,
    layoutBox: layoutBox, toLabel: toLabel, lastNameOf: lastNameOf, paginate: paginate, minPtOf: minPtOf, MIN_PT: MIN_PT, MIN_PT_FLOOR: MIN_PT_FLOOR, MAX_PT: MAX_PT
  };
})();

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = Site.esc;
  var store = Site.store;

  var settings = Object.assign({
    showNumber: true, nameStyle: 'report', offX: 0, offY: 0, outlines: false,
    rotate: 0, numberAtBottom: false, lastNames: false, sep: '&', turnPreview: false, minPt: MNL.MIN_PT
  }, store.get('mnl.settings', {}));
  if ([0, 90].indexOf(Number(settings.rotate)) === -1) settings.rotate = 0;
  settings.rotate = Number(settings.rotate);
  if (['&', '/'].indexOf(settings.sep) === -1) settings.sep = '&';
  if (!MNL.STOCKS[settings.stock]) settings.stock = MNL.DEFAULT_STOCK;
  settings.minPt = MNL.minPtOf(settings);
  function stock() { return MNL.getStock(settings.stock); }
  function saveSettings() { store.set('mnl.settings', settings); }

  var state = {
    report: null,
    selected: new Set(),
    edits: new Map(),     /* "nbr:i" -> { include?: boolean, text?: string } */
    open: new Set(),
    start: 1,
    filter: 'all',
    query: ''
  };
  function boxes() { return state.report ? state.report.boxes : []; }

  /* ---------- Text measuring: Helvetica metrics from jsPDF, canvas as a fallback ---------- */
  var measure = (function () {
    if (window.jspdf && window.jspdf.jsPDF) {
      var m = new window.jspdf.jsPDF({ unit: 'in', format: 'letter' });
      return function (t, size, bold) { m.setFont('helvetica', bold ? 'bold' : 'normal'); m.setFontSize(size); return m.getTextWidth(t); };
    }
    var ctx = document.createElement('canvas').getContext('2d');
    return function (t, size, bold) { ctx.font = (bold ? 'bold ' : '') + '100px Helvetica, Arial, sans-serif'; return ctx.measureText(t).width / 100 * size / 72; };
  })();

  /* ---------- Names and layout ---------- */
  function statusClass(s) {
    s = (s || '').toLowerCase();
    if (s.indexOf('closed') === 0) return 'closed';
    if (s.indexOf('past due') === 0) return 'pastdue';
    if (s.indexOf('forward') !== -1) return 'fwd';
    return 'current';
  }
  /* First Last flips people only; business entries split off after a dash stay as written. */
  function styled(n) { return settings.nameStyle === 'first' && !n.business ? MNL.firstLast(n.raw) : n.raw; }
  function edit(nbr, i) { return state.edits.get(nbr + ':' + i) || {}; }
  function included(box, i) { var e = edit(box.nbr, i); return e.include !== undefined ? e.include : !MNL.isClosed(box.names[i].status); }
  function nameText(box, i) { var e = edit(box.nbr, i); return e.text != null ? e.text : styled(box.names[i]); }
  /* A business entry reworded into "LAST, FIRST" form moves up with the people. */
  function isPerson(box, i) {
    var n = box.names[i], e = edit(box.nbr, i);
    return !n.business || (e.text != null && MNL.looksLikePerson(e.text));
  }
  function labelNames(box) {
    var people = [], businesses = [];
    box.names.forEach(function (n, i) {
      if (!included(box, i)) return;
      var t = nameText(box, i).replace(/\s+/g, ' ').trim();
      if (t) (isPerson(box, i) ? people : businesses).push(t);
    });
    return people.concat(businesses);
  }

  /* The first two different last names among the people printed on the label, in label order. */
  function lastNamesFor(box) {
    var out = [], seen = new Set();
    box.names.forEach(function (n, i) {
      if (!included(box, i) || !isPerson(box, i)) return;
      var e = edit(box.nbr, i);
      var last = MNL.lastNameOf(e.text != null ? e.text : n.raw);
      var key = last.toUpperCase();
      if (last && !seen.has(key)) { seen.add(key); out.push(last); }
    });
    var people = out.slice(0, 2);
    return people;
  }

  function layoutOpts(box) {
    var showNames = settings.showNumber && settings.lastNames;
    return {
      showNumber: !!settings.showNumber,
      numberAtBottom: !!settings.numberAtBottom,
      lastNames: showNames ? lastNamesFor(box) : [],
      sep: settings.sep,
      stock: settings.stock,
      rotate: settings.rotate,
      minPt: settings.minPt
    };
  }

  var layoutCache = new Map();
  function layoutFor(box) {
    var names = labelNames(box), opts = layoutOpts(box);
    var key = box.nbr + '|' + JSON.stringify(opts) + '|' + names.join('\n');
    if (!layoutCache.has(key)) {
      if (layoutCache.size > 3000) layoutCache.clear();
      layoutCache.set(key, MNL.layoutBox(box.nbr, names, opts, measure));
    }
    return layoutCache.get(key);
  }
  function selectedBoxes() { return boxes().filter(function (b) { return state.selected.has(b.nbr); }); }
  /* One entry per physical label; a box that runs over gets several, in a row. */
  function plan() {
    var labels = [], boxCount = 0;
    selectedBoxes().forEach(function (b) {
      var lay = layoutFor(b);
      boxCount++;
      lay.parts.forEach(function (part, pi) {
        labels.push({ box: b, lay: lay, part: part, index: pi, of: lay.parts.length });
      });
    });
    var place = MNL.paginate(labels.length, state.start, stock().perSheet);
    var sheets = labels.length ? place[place.length - 1].sheet + 1 : 1;
    return { labels: labels, place: place, sheets: sheets, boxCount: boxCount };
  }

  /* ---------- Box list ---------- */
  function matches(b) {
    var f = state.filter;
    if (f === 'selected' && !state.selected.has(b.nbr)) return false;
    if (f === 'current' && statusClass(b.status) !== 'current' && statusClass(b.status) !== 'fwd') return false;
    if (f === 'pastdue' && statusClass(b.status) !== 'pastdue') return false;
    if (f === 'fwd' && !b.names.some(function (n) { return /forward/i.test(n.status); })) return false;
    var q = state.query.trim().toLowerCase();
    if (!q) return true;
    if (/^\d+$/.test(q)) return String(b.nbr).indexOf(q) === 0;
    return b.names.some(function (n) { return n.raw.toLowerCase().indexOf(q) !== -1; }) || String(b.nbr) === q;
  }

  var CHEVRON = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 5l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function namesHtml(b) {
    var edited = false;
    var rows = b.names.map(function (n, i) {
      var e = edit(b.nbr, i); if (e.text != null || e.include !== undefined) edited = true;
      var on = included(b, i);
      return '<div class="name-row' + (on ? '' : ' is-off') + '">' +
        '<input type="checkbox" id="inc-' + b.nbr + '-' + i + '" data-inc="' + b.nbr + ':' + i + '"' + (on ? ' checked' : '') + ' aria-label="Print ' + esc(n.raw) + '">' +
        '<input class="field" type="text" id="txt-' + b.nbr + '-' + i + '" data-txt="' + b.nbr + ':' + i + '" value="' + esc(nameText(b, i)) + '" spellcheck="false" aria-label="Name as printed">' +
        '</div>';
    }).join('');
    return rows + '<p class="names-foot"><span>Changes here apply to this label only.</span>' +
      (edited ? '<button type="button" class="linkish" data-reset="' + b.nbr + '">Undo changes</button>' : '') + '</p>';
  }

  function rowHtml(b) {
    var sel = state.selected.has(b.nbr), open = state.open.has(b.nbr);
    var first = b.names[0] ? b.names[0].raw : '', more = b.names.length - 1;
    var tip = b.names.length + (b.names.length === 1 ? ' name' : ' names') + (b.due ? ' · due ' + b.due : '') + (b.notes ? ' · ' + b.notes : '');
    return '<li class="row' + (sel ? ' is-sel' : '') + '" data-nbr="' + b.nbr + '">' +
      '<label class="row-main" for="pick-' + b.nbr + '" title="' + esc(tip) + '">' +
        '<input type="checkbox" id="pick-' + b.nbr + '" data-pick="' + b.nbr + '"' + (sel ? ' checked' : '') + '>' +
        '<span class="num">' + b.nbr + '</span>' +
        '<span class="who"><span class="who-first">' + esc(first) + '</span>' + (more > 0 ? '<span class="more">+' + more + '</span>' : '') + '</span>' +
      '</label>' +
      '<button type="button" class="toggle" data-toggle="' + b.nbr + '" aria-expanded="' + open + '" aria-controls="names-' + b.nbr + '" aria-label="Names in box ' + b.nbr + '">' + CHEVRON + '</button>' +
      '<div class="names" id="names-' + b.nbr + '"' + (open ? '' : ' hidden') + '>' + (open ? namesHtml(b) : '') + '</div>' +
      '</li>';
  }

  function renderList() {
    var all = boxes(), shown = all.filter(matches);
    var emptyMsg = !state.report ? 'Load the Mailnames report above and its mailboxes will be listed here.'
      : state.filter === 'selected' ? 'No boxes selected yet.' : 'No boxes match.';
    $('list').innerHTML = shown.length ? shown.map(rowHtml).join('') : '<li class="empty-list">' + emptyMsg + '</li>';
    $('list-count').textContent = shown.length === all.length ? all.length + ' boxes' : shown.length + ' of ' + all.length + ' boxes';
  }
  function renderCount() { $('sel-count').textContent = state.selected.size; }

  /* ---------- Report card ---------- */
  function renderReport() {
    var r = state.report;
    $('picker-tools').hidden = !r;
    $('file-btn-text').textContent = r ? 'Load another' : 'Choose PDF';
    $('drop-title').textContent = r ? r.fileName : 'Drop the Mailnames Report PDF here';
    $('drop-sub').textContent = r ? 'Drop a newer report here to replace it.' : 'Active Mailboxes Only, sorted by mailbox number. The file is read in this browser and never uploaded.';
    var meta = $('report-meta');
    if (!r) { meta.hidden = true; meta.innerHTML = ''; return; }
    var rows = [];
    if (r.store.length) rows.push(['Store', r.store.slice(0, 2).join(' · ')]);
    if (r.printed) rows.push(['Printed', r.printed]);
    var entries = r.boxes.reduce(function (s, b) { return s + b.names.length; }, 0);
    rows.push(['Read', r.boxes.length + ' boxes, ' + entries + ' names and businesses']);
    if (r.warnings.length) rows.push(['Check', r.warnings.slice(0, 3).join('; ') + (r.warnings.length > 3 ? ' and ' + (r.warnings.length - 3) + ' more' : '')]);
    meta.innerHTML = rows.map(function (x) { return '<dt>' + esc(x[0]) + '</dt><dd>' + esc(x[1]) + '</dd>'; }).join('');
    meta.hidden = false;
  }

  /* ---------- Start position ---------- */
  function renderStart() {
    var st = stock(), html = '';
    /* Button shape follows the label's proportions. */
    $('start-grid').style.setProperty('--slot-h', Math.round(46 * st.label.h / st.label.w) + 'px');
    for (var i = 1; i <= st.perSheet; i++) {
      var cls = i === state.start ? 'is-start' : (i < state.start ? 'is-used' : '');
      html += '<button type="button" role="radio" data-start="' + i + '" class="' + cls + '" aria-checked="' + (i === state.start) + '" aria-label="Start at label ' + i + (i < state.start ? ' (labels before it are used)' : '') + '">' + i + '</button>';
    }
    $('start-grid').innerHTML = html;
  }
  function setStart(n) { state.start = Math.max(1, Math.min(stock().perSheet, n)); renderStart(); schedulePreview(true); }

  /* ---------- Sheet proofs ---------- */
  var P = 72;
  function f2(n) { return Math.round(n * 100) / 100; }
  /* Turns the label's own frame into place on the sheet; matches MNL.toLabel. */
  function rotTransform(rot) {
    var L = stock().label;
    if (rot === 90) return ' transform="translate(' + f2(L.w * P) + ' 0) rotate(90)"';
    if (rot === -90) return ' transform="translate(0 ' + f2(L.h * P) + ') rotate(-90)"';
    return '';
  }
  function slotContent(part) {
    return part.runs.map(function (r) {
      if (r.kind === 'rule') return '<line class="rule" x1="' + f2(r.x * P) + '" y1="' + f2(r.y * P) + '" x2="' + f2((r.x + r.w) * P) + '" y2="' + f2(r.y * P) + '"/>';
      return '<text x="' + f2(r.x * P) + '" y="' + f2(r.y * P) + '" font-size="' + r.size + '"' + (r.bold ? ' font-weight="700"' : '') + '>' + esc(r.text) + '</text>';
    }).join('');
  }
  function sheetSvg(sheetIdx, bySlot, first) {
    var st = stock(), L = st.label, s = '<svg viewBox="0 0 612 792" role="img" aria-label="Sheet ' + (sheetIdx + 1) + ' preview">';
    if (first) s += '<defs><pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#ffffff"/><line x1="0" y1="0" x2="0" y2="7" stroke="#c3c8d2" stroke-width="2"/></pattern></defs>';
    st.slots.forEach(function (slot, i) {
      var item = bySlot[i], used = first && i < state.start - 1;
      var cls = 'slot' + (first ? ' pickable' : '') + (item && !item.lay.fits ? ' overflow' : '');
      s += '<g class="' + cls + '"' + (first ? ' data-slot="' + (i + 1) + '"' : '') + ' transform="translate(' + f2(slot.x * P) + ' ' + f2(slot.y * P) + ')">';
      s += '<rect class="die' + (used ? ' used-fill' : '') + '" width="' + f2(L.w * P) + '" height="' + f2(L.h * P) + '" rx="' + f2(L.r * P) + '"/>';
      if (used) s += '<text class="used-text" x="' + f2(L.w * P / 2) + '" y="' + f2(L.h * P / 2 + 4) + '" text-anchor="middle">ALREADY USED</text>';
      else if (item) {
        /* Outer group takes the print-only alignment shift; inner group carries the rotation. */
        s += '<g class="ink"><g' + rotTransform(item.lay.rot) + '>' + slotContent(item.part) + '</g></g>';
        if (item.index > 0) s += '<text class="cont" x="' + f2(L.w * P - 8) + '" y="' + f2(L.h * P - 6) + '" text-anchor="end">box ' + item.box.nbr + ', label ' + (item.index + 1) + ' of ' + item.of + '</text>';
      }
      else s += '<text class="slot-no" x="' + f2(L.w * P - 12) + '" y="' + f2(L.h * P - 10) + '" text-anchor="end">' + (i + 1) + '</text>';
      s += '</g>';
    });
    return s + '</svg>';
  }

  var MAX_SHEETS_SHOWN = 12;
  function renderPreview() {
    var p = plan(), bySheet = [];
    for (var k = 0; k < p.sheets; k++) bySheet.push({});
    p.labels.forEach(function (l, i) { bySheet[p.place[i].sheet][p.place[i].slot] = l; });
    /* Every sheet is rendered so printing the page includes all of them; only the first few show on screen. */
    var html = '';
    for (var s = 0; s < p.sheets; s++) {
      var ranges = Object.keys(bySheet[s]).map(Number);
      var cap = ranges.length ? 'Labels ' + (Math.min.apply(null, ranges) + 1) + '–' + (Math.max.apply(null, ranges) + 1) : 'No labels';
      html += '<div class="sheet' + (s >= MAX_SHEETS_SHOWN ? ' extra' : '') + '"><div class="sheet-cap"><span>Sheet ' + (s + 1) + ' of ' + p.sheets + '</span><span>' + cap + '</span></div>' + '<div class="paper">' + sheetSvg(s, bySheet[s], s === 0) + '</div></div>';
    }
    if (p.sheets > MAX_SHEETS_SHOWN) html += '<p class="sheet-more">' + (p.sheets - MAX_SHEETS_SHOWN) + ' more sheets are not shown here, but they are in the PDF and print with the page.</p>';
    $('sheets').innerHTML = html;
    renderSummary(p);
  }

  function renderSummary(p) {
    var n = p.labels.length, el = $('summary'), btn = $('download');
    btn.disabled = !n;
    if (!n) { el.innerHTML = state.report ? 'Select boxes to fill the sheet.' : 'Load a Mailnames report to start.'; return; }
    var last = p.place[n - 1], nextFree = last.slot + 2;
    var firsts = p.labels.filter(function (l) { return l.index === 0; });
    var tight = firsts.filter(function (l) { return !l.lay.fits; }).map(function (l) { return l.box.nbr; });
    var empty = firsts.filter(function (l) { return l.lay.empty; }).map(function (l) { return l.box.nbr; });
    var overBoxes = firsts.filter(function (l) { return l.of > 1; });
    var allOne = overBoxes.every(function (l) { return l.of === 2; });
    var overText = '';
    if (overBoxes.length === 1) {
      var ob = overBoxes[0];
      overText = 'Box ' + ob.box.nbr + ' runs onto ' + (ob.of === 2 ? 'an extra label.' : (ob.of - 1) + ' extra labels.');
    } else if (overBoxes.length) {
      overText = 'Boxes ' + listText(overBoxes.map(function (l) { return l.box.nbr + (allOne ? '' : ' (' + (l.of - 1) + ' extra)'); })) +
        ' run onto ' + (allOne ? 'an extra label each.' : 'extra labels.');
    }
    var plural = function (k, one, many) { return k + ' ' + (k === 1 ? one : many); };
    var lead = '<strong>' + plural(n, 'label', 'labels') + '</strong>' + (n !== p.boxCount ? ' for ' + plural(p.boxCount, 'box', 'boxes') : '') +
      ' on <strong>' + plural(p.sheets, 'sheet', 'sheets') + '</strong>, starting at label ' + state.start + '.';
    var parts = [lead];
    parts.push(nextFree <= stock().perSheet ? 'Label ' + nextFree + ' is the next free one on the last sheet.' : 'The last sheet is used up.');
    if (overText) parts.push('<br><span class="muted">' + overText + '</span>');
    if (tight.length) parts.push('<br><span class="warn-text">A name on box ' + tight.join(', ') + ' is too long to fit on one label. Shorten it in the box\'s name list.</span>');
    if (empty.length) parts.push('<br><span class="muted">No names left to print on box ' + empty.join(', ') + '.</span>');
    el.innerHTML = parts.join(' ');
  }

  function listText(items) {
    if (items.length <= 2) return items.join(' and ');
    if (items.length > 8) return items.slice(0, 8).join(', ') + ' and ' + (items.length - 8) + ' more';
    return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
  }

  var previewTimer = null;
  function schedulePreview(now) {
    clearTimeout(previewTimer);
    if (now) renderPreview(); else previewTimer = setTimeout(renderPreview, 120);
  }

  /* ---------- PDF ---------- */
  function buildPdf() {
    var p = plan(), st = stock(), doc = new window.jspdf.jsPDF({ unit: 'in', format: 'letter', orientation: 'portrait' });
    doc.setProperties({ title: 'Mailbox name labels', creator: 'Mailbox Name Labels' });
    for (var s = 0; s < p.sheets; s++) {
      if (s) doc.addPage('letter', 'portrait');
      if (settings.outlines) {
        doc.setDrawColor(150, 158, 196); doc.setLineWidth(0.75 / 72);
        st.slots.forEach(function (sl) { doc.roundedRect(sl.x, sl.y, st.label.w, st.label.h, st.label.r, st.label.r, 'S'); });
      }
    }
    var ox = Number(settings.offX) || 0, oy = Number(settings.offY) || 0;
    p.labels.forEach(function (l, i) {
      var pl = p.place[i], slot = st.slots[pl.slot], rot = l.lay.rot;
      var at = function (x, y) { var q = MNL.toLabel(x, y, rot, st); return { x: slot.x + q.x + ox, y: slot.y + q.y + oy }; };
      /* jsPDF turns text counter-clockwise for a positive angle. */
      var angle = rot === 90 ? -90 : rot === -90 ? 90 : 0;
      doc.setPage(pl.sheet + 1);
      l.part.runs.forEach(function (r) {
        if (r.kind === 'rule') {
          var a = at(r.x, r.y), b = at(r.x + r.w, r.y);
          doc.setDrawColor(0, 0, 0); doc.setLineWidth(0.6 / 72); doc.line(a.x, a.y, b.x, b.y);
          return;
        }
        var pt = at(r.x, r.y);
        doc.setFont('helvetica', r.bold ? 'bold' : 'normal');
        doc.setFontSize(r.size);
        doc.setTextColor(0, 0, 0);
        doc.text(r.text, pt.x, pt.y, angle ? { baseline: 'alphabetic', angle: angle } : { baseline: 'alphabetic' });
      });
    });
    return { doc: doc, plan: p };
  }

  function today() {
    var d = new Date(), pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function saveStatus(text, isError) {
    var el = $('save-status');
    el.textContent = text;
    el.style.color = isError ? 'var(--pastdue)' : 'var(--ink-2)';
  }

  async function download() {
    if (!window.jspdf || !window.jspdf.jsPDF) { saveStatus('The PDF maker could not be loaded. Reload the page and try again.', true); return; }
    var built = buildPdf(), blob = built.doc.output('blob');
    var first = built.plan.labels[0].box.nbr, last = built.plan.labels[built.plan.labels.length - 1].box.nbr;
    var filename = 'Mailbox labels ' + (first === last ? first : first + '-' + last) + ' ' + today() + '.pdf';
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    saveStatus('Downloading ' + filename + '. Print it at Actual size.');
  }

  /* ---------- Import ---------- */
  async function importFile(file) {
    if (!file) return;
    var err = $('import-error');
    err.hidden = true;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { showImportError(file.name + ' is not a PDF. Export the Mailnames Report as a PDF and load that.'); return; }
    $('drop-title').textContent = 'Reading ' + file.name + '…';
    try {
      var pages = (await PdfReader.readPages(file)).map(function (items) { return { items: items }; });
      var r = MNL.parseReport(pages);
      if (r.error) throw new Error(r.error);
      if (!r.boxes.length) throw new Error('No mailbox rows were found in ' + file.name + '. Load the Mailnames Report (Active Mailboxes Only).');
      r.fileName = file.name;
      state.report = r;
      state.selected = new Set();
      state.edits = new Map();
      state.open = new Set();
      layoutCache.clear();
      if (state.filter === 'selected') { state.filter = 'all'; $('f-all').checked = true; }
      renderAll();
    } catch (e) {
      renderReport();
      showImportError((e && e.message) || 'This PDF could not be read.');
    }
  }
  function showImportError(msg) { var el = $('import-error'); el.textContent = msg; el.hidden = false; }

  /* ---------- Quick select ---------- */
  /* "101, 105 120-130" -> singles and ranges. Gaps inside a range are normal (unrented boxes), so only singles are reported missing. */
  function parseNumbers(text) {
    var singles = [], ranged = [], bad = [];
    text.replace(/\s*[-–—]\s*/g, '-').split(/[\s,;]+/).filter(Boolean).forEach(function (tok) {
      var m = tok.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) { bad.push(tok); return; }
      if (!m[2]) { singles.push(Number(m[1])); return; }
      var a = Number(m[1]), b = Number(m[2]);
      if (b < a) { var t = a; a = b; b = t; }
      if (b - a > 10000) { bad.push(tok); return; }
      for (var n = a; n <= b; n++) ranged.push(n);
    });
    return { singles: singles, ranged: ranged, bad: bad };
  }
  function quickSelect(text) {
    var parsed = parseNumbers(text), have = new Set(boxes().map(function (b) { return b.nbr; }));
    var added = 0, missing = [];
    parsed.singles.concat(parsed.ranged).forEach(function (n, i) {
      if (have.has(n)) { if (!state.selected.has(n)) added++; state.selected.add(n); }
      else if (i < parsed.singles.length) missing.push(n);
    });
    var msg = added ? 'Selected ' + added + (added === 1 ? ' box.' : ' boxes.') : 'No new boxes selected.';
    if (missing.length) msg += ' Not in this report: ' + missing.slice(0, 12).join(', ') + (missing.length > 12 ? '…' : '') + '.';
    if (parsed.bad.length) msg += ' Skipped “' + parsed.bad.join(' ') + '”.';
    var el = $('quick-msg'); el.textContent = msg; el.hidden = false;
    renderList(); renderCount(); schedulePreview(true);
  }

  /* ---------- Wiring ---------- */
  function renderAll() { renderReport(); renderList(); renderCount(); renderStart(); renderPreview(); }

  function syncSettingsUI() {
    $('show-number').checked = !!settings.showNumber;
    $('style-' + (settings.nameStyle === 'first' ? 'first' : 'report')).checked = true;
    $('off-x').value = settings.offX || 0;
    $('off-y').value = settings.offY || 0;
    $('min-pt').value = settings.minPt;
    $('outlines').checked = !!settings.outlines;
    $(settings.rotate === 90 ? 'rot-r' : 'rot-0').checked = true;
    syncTurn();
    $('stock').value = settings.stock;
    $('number-bottom').checked = !!settings.numberAtBottom;
    $('last-names').checked = !!settings.lastNames;
    $(settings.sep === '/' ? 'sep-slash' : 'sep-amp').checked = true;
    syncDependents();
  }
  /* The turn button only appears while text is rotated; turning lays the on-screen sheets on their side. */
  function syncTurn() {
    var rotated = settings.rotate === 90, turned = rotated && !!settings.turnPreview;
    $('sheet-tools').hidden = !rotated;
    $('sheets').classList.toggle('turned', turned);
    $('turn').setAttribute('aria-pressed', String(turned));
    $('turn').textContent = turned ? 'Turn preview upright' : 'Turn preview sideways';
  }
  /* Number position and last names only mean something while the box number prints. */
  function syncDependents() {
    var num = !!settings.showNumber, names = num && !!settings.lastNames;
    $('number-bottom').disabled = !num;
    $('last-names').disabled = !num;
    $('bottom-wrap').classList.toggle('is-disabled', !num);
    $('last-wrap').classList.toggle('is-disabled', !num);
    document.querySelectorAll('input[name="sep"]').forEach(function (r) { r.disabled = !names; });
    $('sep-wrap').classList.toggle('is-disabled', !names);
  }

  $('file').addEventListener('change', function (e) { importFile(e.target.files[0]); e.target.value = ''; });
  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('is-over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove('is-over'); }); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); importFile(e.dataTransfer.files[0]); });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); if (!drop.contains(e.target) && e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]); });

  $('quick-form').addEventListener('submit', function (e) { e.preventDefault(); var v = $('quick').value; if (v.trim()) { quickSelect(v); $('quick').value = ''; } });
  $('search').addEventListener('input', function (e) { state.query = e.target.value; renderList(); });
  document.querySelectorAll('input[name="filter"]').forEach(function (r) { r.addEventListener('change', function () { state.filter = r.value; renderList(); }); });
  $('select-shown').addEventListener('click', function () { boxes().filter(matches).forEach(function (b) { state.selected.add(b.nbr); }); renderList(); renderCount(); schedulePreview(true); });
  $('clear-sel').addEventListener('click', function () { state.selected.clear(); renderList(); renderCount(); schedulePreview(true); });

  $('list').addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset.pick) {
      var n = Number(t.dataset.pick);
      if (t.checked) state.selected.add(n); else state.selected.delete(n);
      t.closest('.row').classList.toggle('is-sel', t.checked);
      renderCount(); schedulePreview();
    } else if (t.dataset.inc) {
      var e1 = Object.assign({}, state.edits.get(t.dataset.inc) || {}, { include: t.checked });
      state.edits.set(t.dataset.inc, e1);
      t.closest('.name-row').classList.toggle('is-off', !t.checked);
      refreshFoot(Number(t.dataset.inc.split(':')[0]));
      schedulePreview();
    }
  });
  $('list').addEventListener('input', function (e) {
    var t = e.target;
    if (!t.dataset.txt) return;
    var e1 = Object.assign({}, state.edits.get(t.dataset.txt) || {}, { text: t.value });
    state.edits.set(t.dataset.txt, e1);
    refreshFoot(Number(t.dataset.txt.split(':')[0]));
    schedulePreview();
  });
  $('list').addEventListener('click', function (e) {
    var tg = e.target.closest('[data-toggle]');
    if (tg) {
      var n = Number(tg.dataset.toggle), panel = $('names-' + n), box = boxes().find(function (b) { return b.nbr === n; });
      var open = !state.open.has(n);
      if (open) { state.open.add(n); panel.innerHTML = namesHtml(box); } else state.open.delete(n);
      panel.hidden = !open; tg.setAttribute('aria-expanded', String(open));
      return;
    }
    var rs = e.target.closest('[data-reset]');
    if (rs) {
      var nb = Number(rs.dataset.reset), bx = boxes().find(function (b) { return b.nbr === nb; });
      bx.names.forEach(function (_, i) { state.edits.delete(nb + ':' + i); });
      $('names-' + nb).innerHTML = namesHtml(bx);
      schedulePreview(true);
    }
  });
  function refreshFoot(nbr) {
    var panel = $('names-' + nbr); if (!panel) return;
    var foot = panel.querySelector('.names-foot');
    if (foot && !foot.querySelector('[data-reset]')) foot.insertAdjacentHTML('beforeend', '<button type="button" class="linkish" data-reset="' + nbr + '">Undo changes</button>');
  }

  $('start-grid').addEventListener('click', function (e) { var b = e.target.closest('[data-start]'); if (b) setStart(Number(b.dataset.start)); });
  $('start-grid').addEventListener('keydown', function (e) {
    var d = { ArrowRight: 1, ArrowDown: 2, ArrowLeft: -1, ArrowUp: -2 }[e.key];
    if (!d) return;
    e.preventDefault(); setStart(state.start + d);
    var btn = $('start-grid').querySelector('[data-start="' + state.start + '"]'); if (btn) btn.focus();
  });
  $('sheets').addEventListener('click', function (e) { var g = e.target.closest('[data-slot]'); if (g) setStart(Number(g.dataset.slot)); });

  $('show-number').addEventListener('change', function (e) { settings.showNumber = e.target.checked; saveSettings(); syncDependents(); schedulePreview(true); });
  document.querySelectorAll('input[name="rotate"]').forEach(function (r) {
    r.addEventListener('change', function () { settings.rotate = Number(r.value); saveSettings(); syncTurn(); schedulePreview(true); });
  });
  /* A partly used sheet of one stock says nothing about the other, so switching starts at label 1. */
  $('stock').addEventListener('change', function (e) {
    if (!MNL.STOCKS[e.target.value]) return;
    settings.stock = e.target.value; saveSettings(); sizeStockSelect(); setStart(1);
  });
  /* A select is as wide as its longest option; fit it to the one showing instead. */
  var measureCtx = null;
  function sizeStockSelect() {
    var sel = $('stock'), cs = getComputedStyle(sel), opt = sel.options[sel.selectedIndex];
    if (!opt) return;
    measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
    measureCtx.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
    var spacing = parseFloat(cs.letterSpacing) || 0;
    var w = measureCtx.measureText(opt.text).width + opt.text.length * spacing +
      parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth) + 2;
    sel.style.width = Math.ceil(w) + 'px';
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(sizeStockSelect);
  $('turn').addEventListener('click', function () { settings.turnPreview = !settings.turnPreview; saveSettings(); syncTurn(); });
  $('number-bottom').addEventListener('change', function (e) { settings.numberAtBottom = e.target.checked; saveSettings(); schedulePreview(true); });
  $('last-names').addEventListener('change', function (e) { settings.lastNames = e.target.checked; saveSettings(); syncDependents(); schedulePreview(true); });
  document.querySelectorAll('input[name="sep"]').forEach(function (r) {
    r.addEventListener('change', function () { settings.sep = r.value; saveSettings(); schedulePreview(true); });
  });
  document.querySelectorAll('input[name="style"]').forEach(function (r) {
    r.addEventListener('change', function () { settings.nameStyle = r.value; saveSettings(); renderList(); schedulePreview(true); });
  });
  /* Alignment shift and outlines also apply when the page itself is printed. */
  function applyPrintSettings() {
    var rs = document.documentElement.style;
    rs.setProperty('--print-ox', ((Number(settings.offX) || 0) * 72) + 'px');
    rs.setProperty('--print-oy', ((Number(settings.offY) || 0) * 72) + 'px');
    $('sheets').classList.toggle('print-outlines', !!settings.outlines);
  }
  function readOffset(id, key) {
    var v = parseFloat($(id).value);
    settings[key] = isFinite(v) ? Math.max(-0.5, Math.min(0.5, v)) : 0;
    saveSettings(); applyPrintSettings();
  }
  /* The preview follows the field as it is typed in; the value is tidied once it is left. */
  $('min-pt').addEventListener('input', function (e) {
    if (e.target.value === '') return;
    settings.minPt = MNL.minPtOf({ minPt: e.target.value }); saveSettings(); schedulePreview();
  });
  $('min-pt').addEventListener('change', function (e) {
    settings.minPt = MNL.minPtOf({ minPt: e.target.value });
    e.target.value = settings.minPt; saveSettings(); schedulePreview(true);
  });
  $('off-x').addEventListener('change', function () { readOffset('off-x', 'offX'); });
  $('off-y').addEventListener('change', function () { readOffset('off-y', 'offY'); });
  $('outlines').addEventListener('change', function (e) { settings.outlines = e.target.checked; saveSettings(); applyPrintSettings(); });
  $('download').addEventListener('click', function () { download().catch(function (e) { saveStatus('The PDF could not be made: ' + ((e && e.message) || 'unknown error'), true); }); });

  syncSettingsUI();
  sizeStockSelect();
  applyPrintSettings();
  renderAll();

})();
