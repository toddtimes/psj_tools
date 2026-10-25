/* Mailbox Name Labels: report parsing and label layout. Pure functions, no DOM. */
var MNL = (function () {
  'use strict';

  /* ---------- Label stock: measured from the 8-up template (inches) ---------- */
  var SHEET = { w: 8.5, h: 11 };
  var LABEL = { w: 3.4125, h: 2.3365, r: 0.13 };
  var COLS_X = [0.67, 4.4176];
  var ROWS_Y = [0.5952, 3.0862, 5.5773, 8.0683];
  var SLOTS = [];
  ROWS_Y.forEach(function (y) { COLS_X.forEach(function (x) { SLOTS.push({ x: x, y: y }); }); });

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
      if (p) out.push({ text: p, business: i > 0 });
    });
    return out;
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
     Returns runs with x, y (baseline) relative to the label's top-left, in inches. */
  var PAD_X = 0.19, PAD_TOP = 0.17, PAD_BOTTOM = 0.15;
  var NUM_PT = 19, MAX_PT = 12, MIN_PT = 5.5, STEP = 0.25, COL_GAP = 0.16, INDENT = 0.13;
  var LEAD = 1.2, NAME_GAP = 0.22; /* line height and extra space between names, in ems */

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

  /* Wraps a name, preferring to break after the dash that separates a person from a business. */
  function wrap(text, width, sizePt, measure) {
    var greedy = wrapWords(text, width, width - INDENT, sizePt, measure);
    if (!greedy || greedy.length < 2) return greedy;
    var m = text.match(/^(.*?\s[–—-])\s+(.*)$/);
    if (!m) return greedy;
    var head = wrapWords(m[1], width, width - INDENT, sizePt, measure);
    var tail = wrapWords(m[2], width - INDENT, width - INDENT, sizePt, measure);
    if (head && tail && head.length + tail.length <= greedy.length) return head.concat(tail);
    return greedy;
  }

  function blockHeight(wrapped, sizePt) {
    if (!wrapped.length) return 0;
    var lh = sizePt * LEAD / 72, gap = sizePt * NAME_GAP / 72, lines = 0;
    wrapped.forEach(function (w) { lines += w.length; });
    return lines * lh + (wrapped.length - 1) * gap;
  }

  function tryFit(names, cols, sizePt, availW, availH, measure) {
    var colW = cols === 1 ? availW : (availW - COL_GAP) / 2;
    var wrapped = [];
    for (var i = 0; i < names.length; i++) {
      var w = wrap(names[i], colW, sizePt, measure);
      if (!w) return null;
      wrapped.push(w);
    }
    if (cols === 1) return blockHeight(wrapped, sizePt) <= availH + 1e-6 ? { colW: colW, columns: [wrapped] } : null;
    var best = null;
    for (var k = 1; k < wrapped.length; k++) {
      var a = wrapped.slice(0, k), b = wrapped.slice(k);
      var h = Math.max(blockHeight(a, sizePt), blockHeight(b, sizePt));
      if (!best || h < best.h - 1e-9) best = { h: h, columns: [a, b] };
    }
    return best && best.h <= availH + 1e-6 ? { colW: colW, columns: best.columns } : null;
  }

  function largestFit(names, cols, availW, availH, measure) {
    var steps = Math.round((MAX_PT - MIN_PT) / STEP);
    var lo = 0, hi = steps, found = null;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1, size = MIN_PT + mid * STEP;
      var fit = tryFit(names, cols, size, availW, availH, measure);
      if (fit) { found = { size: size, fit: fit }; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  /* Two narrow columns only pay off when names stay on one line, so each wrapped line
     costs WRAP_COST points against the font size when comparing with one column. */
  var WRAP_COST = 6;
  function bestTwoColumn(names, availW, availH, measure) {
    var best = null;
    for (var size = MAX_PT; size >= MIN_PT - 1e-9; size -= STEP) {
      var fit = tryFit(names, 2, size, availW, availH, measure);
      if (!fit) continue;
      var lines = 0;
      fit.columns.forEach(function (col) { col.forEach(function (w) { lines += w.length; }); });
      var score = size - WRAP_COST * (lines - names.length) / names.length;
      if (!best || score > best.score + 1e-9) best = { size: size, fit: fit, score: score };
      if (lines === names.length) break; /* smaller sizes cannot score higher */
    }
    return best;
  }

  function hardWrap(text, width, sizePt, measure) {
    var lines = [], line = '';
    text.split(' ').forEach(function (word) {
      var trial = line ? line + ' ' + word : word;
      var avail = lines.length ? width - INDENT : width;
      if (measure(trial, sizePt) <= avail || !line) line = trial;
      else { lines.push(line); line = word; }
    });
    if (line) lines.push(line);
    return lines;
  }

  function layoutLabel(nbr, names, opts, measure) {
    var runs = [], top = PAD_TOP;
    var availW = LABEL.w - PAD_X * 2;
    if (opts.showNumber) {
      var numCap = NUM_PT * 0.718 / 72;
      var base = PAD_TOP + numCap;
      var numX = (LABEL.w - measure(String(nbr), NUM_PT, true)) / 2; /* centered on the label */
      runs.push({ kind: 'num', text: String(nbr), x: numX, y: base, size: NUM_PT, bold: true });
      var ruleY = base + 0.075;
      runs.push({ kind: 'rule', x: PAD_X, y: ruleY, w: availW });
      top = ruleY + 0.085;
    }
    var availH = LABEL.h - PAD_BOTTOM - top;
    if (!names.length) return { runs: runs, size: 0, cols: 1, fits: true, empty: true };

    var one = largestFit(names, 1, availW, availH, measure);
    var two = names.length >= 3 ? bestTwoColumn(names, availW, availH, measure) : null;
    var pick = one, cols = 1, fits = true;
    if (two && (!one || two.score >= one.size + 0.5)) { pick = two; cols = 2; }
    if (!pick) {
      /* Too many names even at the smallest size: set it at the minimum and flag it. */
      fits = false; cols = names.length >= 3 ? 2 : 1;
      var cw = cols === 1 ? availW : (availW - COL_GAP) / 2;
      var wrapped = names.map(function (n) { return hardWrap(n, cw, MIN_PT, measure); });
      var split = Math.ceil(wrapped.length / 2);
      pick = { size: MIN_PT, fit: { colW: cw, columns: cols === 1 ? [wrapped] : [wrapped.slice(0, split), wrapped.slice(split)] } };
    }

    var size = pick.size, lh = size * LEAD / 72, gap = size * NAME_GAP / 72, asc = size * 0.718 / 72;
    pick.fit.columns.forEach(function (col, ci) {
      var x0 = PAD_X + ci * (pick.fit.colW + COL_GAP), y = top + asc;
      col.forEach(function (lines, ni) {
        lines.forEach(function (line, li) {
          runs.push({ kind: 'name', text: line, x: x0 + (li ? INDENT : 0), y: y, size: size, bold: false });
          y += lh;
        });
        if (ni < col.length - 1) y += gap;
      });
    });
    return { runs: runs, size: size, cols: cols, fits: fits };
  }

  /* Places labels on sheets. start is 1-8, the first free label on the first sheet. */
  function paginate(count, start) {
    var out = [], slot = Math.max(0, Math.min(7, (start || 1) - 1)), sheet = 0;
    for (var i = 0; i < count; i++) {
      out.push({ sheet: sheet, slot: slot });
      slot++;
      if (slot > 7) { slot = 0; sheet++; }
    }
    return out;
  }

  return {
    SHEET: SHEET, LABEL: LABEL, SLOTS: SLOTS,
    parseReport: parseReport, isClosed: isClosed, firstLast: firstLast, cleanName: cleanName, splitEntry: splitEntry,
    layoutLabel: layoutLabel, paginate: paginate
  };
})();

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = Site.esc;
  var store = Site.store;

  var settings = Object.assign({ showNumber: true, nameStyle: 'report', offX: 0, offY: 0, outlines: false }, store.get('mnl.settings', {}));
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
  function labelNames(box) {
    var out = [];
    box.names.forEach(function (n, i) { if (included(box, i)) { var t = nameText(box, i).replace(/\s+/g, ' ').trim(); if (t) out.push(t); } });
    return out;
  }

  var layoutCache = new Map();
  function layoutFor(box) {
    var names = labelNames(box);
    var key = box.nbr + '|' + (settings.showNumber ? 1 : 0) + '|' + names.join('\n');
    if (!layoutCache.has(key)) {
      if (layoutCache.size > 3000) layoutCache.clear();
      layoutCache.set(key, MNL.layoutLabel(box.nbr, names, { showNumber: settings.showNumber }, measure));
    }
    return layoutCache.get(key);
  }
  function selectedBoxes() { return boxes().filter(function (b) { return state.selected.has(b.nbr); }); }
  function plan() {
    var labels = selectedBoxes().map(function (b) { return { box: b, lay: layoutFor(b) }; });
    var place = MNL.paginate(labels.length, state.start);
    var sheets = labels.length ? place[place.length - 1].sheet + 1 : 1;
    return { labels: labels, place: place, sheets: sheets };
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
      var odd = n.status && n.status !== b.status;
      return '<div class="name-row' + (on ? '' : ' is-off') + '">' +
        '<input type="checkbox" id="inc-' + b.nbr + '-' + i + '" data-inc="' + b.nbr + ':' + i + '"' + (on ? ' checked' : '') + ' aria-label="Print ' + esc(n.raw) + '">' +
        '<input class="field" type="text" id="txt-' + b.nbr + '-' + i + '" data-txt="' + b.nbr + ':' + i + '" value="' + esc(nameText(b, i)) + '" spellcheck="false" aria-label="Name as printed">' +
        (odd ? '<span class="chip ' + statusClass(n.status) + '">' + esc(n.status) + '</span>' : '') +
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
      '<span class="chip ' + statusClass(b.status) + '">' + esc(b.status || 'Unknown') + '</span>' +
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
    var html = '';
    for (var i = 1; i <= 8; i++) {
      var cls = i === state.start ? 'is-start' : (i < state.start ? 'is-used' : '');
      html += '<button type="button" role="radio" data-start="' + i + '" class="' + cls + '" aria-checked="' + (i === state.start) + '" aria-label="Start at label ' + i + (i < state.start ? ' (labels before it are used)' : '') + '">' + i + '</button>';
    }
    $('start-grid').innerHTML = html;
  }
  function setStart(n) { state.start = Math.max(1, Math.min(8, n)); renderStart(); schedulePreview(true); }

  /* ---------- Sheet proofs ---------- */
  var P = 72;
  function f2(n) { return Math.round(n * 100) / 100; }
  function slotContent(lay) {
    return lay.runs.map(function (r) {
      if (r.kind === 'rule') return '<line class="rule" x1="' + f2(r.x * P) + '" y1="' + f2(r.y * P) + '" x2="' + f2((r.x + r.w) * P) + '" y2="' + f2(r.y * P) + '"/>';
      return '<text x="' + f2(r.x * P) + '" y="' + f2(r.y * P) + '" font-size="' + r.size + '"' + (r.bold ? ' font-weight="700"' : '') + '>' + esc(r.text) + '</text>';
    }).join('');
  }
  function sheetSvg(sheetIdx, bySlot, first) {
    var L = MNL.LABEL, s = '<svg viewBox="0 0 612 792" role="img" aria-label="Sheet ' + (sheetIdx + 1) + ' preview">';
    if (first) s += '<defs><pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="#ffffff"/><line x1="0" y1="0" x2="0" y2="7" stroke="#c3c8d2" stroke-width="2"/></pattern></defs>';
    MNL.SLOTS.forEach(function (slot, i) {
      var item = bySlot[i], used = first && i < state.start - 1;
      var cls = 'slot' + (first ? ' pickable' : '') + (item && !item.lay.fits ? ' overflow' : '');
      s += '<g class="' + cls + '"' + (first ? ' data-slot="' + (i + 1) + '"' : '') + ' transform="translate(' + f2(slot.x * P) + ' ' + f2(slot.y * P) + ')">';
      s += '<rect class="die' + (used ? ' used-fill' : '') + '" width="' + f2(L.w * P) + '" height="' + f2(L.h * P) + '" rx="' + f2(L.r * P) + '"/>';
      if (used) s += '<text class="used-text" x="' + f2(L.w * P / 2) + '" y="' + f2(L.h * P / 2 + 4) + '" text-anchor="middle">ALREADY USED</text>';
      else if (item) s += '<g class="ink">' + slotContent(item.lay) + '</g>';
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
      html += '<div class="sheet' + (s >= MAX_SHEETS_SHOWN ? ' extra' : '') + '"><div class="sheet-cap"><span>Sheet ' + (s + 1) + ' of ' + p.sheets + '</span><span>' + cap + '</span></div>' + sheetSvg(s, bySheet[s], s === 0) + '</div>';
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
    var tight = p.labels.filter(function (l) { return !l.lay.fits; }).map(function (l) { return l.box.nbr; });
    var empty = p.labels.filter(function (l) { return l.lay.empty; }).map(function (l) { return l.box.nbr; });
    var parts = ['<strong>' + n + (n === 1 ? ' label' : ' labels') + '</strong> on <strong>' + p.sheets + (p.sheets === 1 ? ' sheet' : ' sheets') + '</strong>, starting at label ' + state.start + '.'];
    parts.push(nextFree <= 8 ? 'Label ' + nextFree + ' is the next free one on the last sheet.' : 'The last sheet is used up.');
    if (tight.length) parts.push('<br><span class="warn-text">Too many names to fit on box ' + tight.join(', ') + ' even at the smallest size. Untick or shorten some names.</span>');
    if (empty.length) parts.push('<br><span class="muted">No names left to print on box ' + empty.join(', ') + '.</span>');
    el.innerHTML = parts.join(' ');
  }

  var previewTimer = null;
  function schedulePreview(now) {
    clearTimeout(previewTimer);
    if (now) renderPreview(); else previewTimer = setTimeout(renderPreview, 120);
  }

  /* ---------- PDF ---------- */
  function buildPdf() {
    var p = plan(), doc = new window.jspdf.jsPDF({ unit: 'in', format: 'letter', orientation: 'portrait' });
    doc.setProperties({ title: 'Mailbox name labels', creator: 'Mailbox Name Labels' });
    for (var s = 0; s < p.sheets; s++) {
      if (s) doc.addPage('letter', 'portrait');
      if (settings.outlines) {
        doc.setDrawColor(150, 158, 196); doc.setLineWidth(0.75 / 72);
        MNL.SLOTS.forEach(function (sl) { doc.roundedRect(sl.x, sl.y, MNL.LABEL.w, MNL.LABEL.h, MNL.LABEL.r, MNL.LABEL.r, 'S'); });
      }
    }
    var ox = Number(settings.offX) || 0, oy = Number(settings.offY) || 0;
    p.labels.forEach(function (l, i) {
      var pl = p.place[i], slot = MNL.SLOTS[pl.slot];
      doc.setPage(pl.sheet + 1);
      l.lay.runs.forEach(function (r) {
        var x = slot.x + r.x + ox, y = slot.y + r.y + oy;
        if (r.kind === 'rule') { doc.setDrawColor(0, 0, 0); doc.setLineWidth(0.6 / 72); doc.line(x, y, x + r.w, y); return; }
        doc.setFont('helvetica', r.bold ? 'bold' : 'normal');
        doc.setFontSize(r.size);
        doc.setTextColor(0, 0, 0);
        doc.text(r.text, x, y, { baseline: 'alphabetic' });
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
    $('outlines').checked = !!settings.outlines;
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

  $('show-number').addEventListener('change', function (e) { settings.showNumber = e.target.checked; saveSettings(); schedulePreview(true); });
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
  $('off-x').addEventListener('change', function () { readOffset('off-x', 'offX'); });
  $('off-y').addEventListener('change', function () { readOffset('off-y', 'offY'); });
  $('outlines').addEventListener('change', function (e) { settings.outlines = e.target.checked; saveSettings(); applyPrintSettings(); });
  $('download').addEventListener('click', function () { download().catch(function (e) { saveStatus('The PDF could not be made: ' + ((e && e.message) || 'unknown error'), true); }); });

  syncSettingsUI();
  applyPrintSettings();
  renderAll();

})();
