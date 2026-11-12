/* The PMB Service Finder's readers and comparison, run on made-up reports laid out like the real ones.
   Every name and box number here is invented; never paste lines from a real report into this file. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../site/js/pmb-service-finder.js', import.meta.url), 'utf8');
const ctx = { module: {} }; vm.createContext(ctx); vm.runInContext(src.slice(0, src.indexOf('\n(function () {')), ctx);
const PMB = ctx.module.exports;

const it = (str, x, y) => ({ str, x, y, w: str.length * 4.6 });
const NS = 'Notification Service', PM = 'Personal Mail Box';

/* rows: [nbr, status, customer, amount] */
function mailbox(rows, total) {
  const p = [it('Mailbox Listing', 270, 740), it('Includes All Mailboxes', 267, 729), it('Page', 542, 713), it('1', 570, 713), it('Example Mail Store', 34, 712), it('11/12/2026 11:30 AM', 496, 701),
    it('Nbr', 37, 660), it('Size/Type', 65, 660), it('Status', 118, 660), it('Customer (Current or Last)', 218, 660), it('Date Closed', 387, 660), it('Term', 445, 660), it('Due Date', 495, 660), it('Amount', 541, 660)];
  let y = 640, sum = 0;
  for (const [nbr, status, customer, amount] of rows) {
    p.push(it(nbr, 37, y), it('Basic', 64, y), it(status, 117, y));
    if (customer) p.push(it(customer, 219, y), it('12 month', 447, y), it('1/1/2027', 497, y), it('555-0100', 219, y - 12));
    if (amount) { p.push(it(amount, 549, y)); sum += Math.round(parseFloat(amount) * 100); }
    y -= 25.5;
  }
  p.push(it('Total Amount Due:', 465, y - 14), it('$' + ((total ?? sum) / 100).toFixed(2), 540, y - 14));
  return [p];
}
/* pages: [[ [nbr, name, service] | [null, null, service] ]] */
function services(pages) {
  return pages.map((rows, i) => {
    const p = [it('Report created:11/12/2026 11:30:41 AM', 407, 763), it('PMB Services Report', 20, 759), it('Page ' + (i + 1) + ' of ' + pages.length, 535, 739),
      it('PMB', 20, 705), it('Boxholder Name', 98, 705), it('Company', 297, 705), it('Service Description', 450, 705), it('PMTools report PMBServicesReport-V1', 20, 31)];
    rows.forEach(([nbr, name, svc], r) => { const y = 689 - r * 18; if (nbr) p.push(it(nbr, 34, y)); if (name) p.push(it(name, 69, y)); if (svc) p.push(it(svc, 425, y)); });
    return p;
  });
}
const run = (mbP, svP) => { const mb = PMB.parseMailboxes(mbP), sv = PMB.parseServices(svP); return { mb, sv, cmp: PMB.compare(mb, sv) }; };
const labels = list => list.map(r => r.label).join(',');
const notice = (list, re) => list.find(n => re.test(n.text));

test('has and missing: Available excluded, --NONE-- and unlisted boxes are missing', () => {
  const r = run(mailbox([['101', 'Current', 'Alex Example'], ['102', 'Available'], ['103', 'Past Due', 'Sam Sample', '120.00'], ['104', 'Current', 'Jo Demo'], ['105', 'Current', 'Pat Mock']]),
    services([[['101', 'Alex Example', NS], [null, null, PM], ['103', 'Sam Sample', PM], ['104', 'Jo Demo', '--NONE--']]]));
  const f = PMB.find(r.cmp, NS);
  assert.equal(labels(f.has), '101');
  assert.equal(labels(f.missing), '103,104,105');
  assert.equal(r.cmp.vacantCount, 1);
  assert.equal(notice(r.cmp.notices, /not in the PMB Services Report at all/).list, '105');
  /* the picker's count is the has-it count */
  assert.deepEqual([...r.cmp.services].map(s => [s.name, s.count, PMB.find(r.cmp, s.name).has.length]), [[PM, 2, 2], [NS, 1, 1]]);
  assert.equal(PMB.mailboxChecks(r.mb).length, 0);
  assert.equal(PMB.servicesChecks(r.sv).length, 0);
});

test('box numbers match across reports whatever the prefix, case or leading zeros', () => {
  assert.deepEqual(['PMB 099', '#99', ' 99 ', 'box 12a', '00'].map(PMB.boxKey), ['99', '99', '99', '12A', '0']);
  const r = run(mailbox([['099', 'Current', 'Alex Example']]), services([[['99', 'Alex Example', NS]]]));
  assert.equal(labels(PMB.find(r.cmp, NS).has), '099');
});

test('Closed and Forwarding listed twice counts once; other repeats raise a notice', () => {
  const r = run(mailbox([['1', 'Closed and Forwarding', 'Old One'], ['1', 'Available'], ['2', 'Closed and Forwarding', 'Old Two'], ['2', 'Current', 'New Two'], ['3', 'Current', 'A'], ['3', 'Current', 'B']]),
    services([[['2', 'New Two', NS], ['3', 'A', NS]]]));
  assert.equal(labels(r.cmp.rented), '1,2,3');
  assert.equal(r.cmp.rented[1].customer, 'New Two');
  assert.match(notice(r.cmp.notices, /more than once on the Mailbox Listing/).list, /^3 /);
  const relet = notice(r.cmp.notices, /both as Closed and Forwarding and under a current customer/);
  assert.equal(relet.cls, 'info');
  assert.match(relet.list, /^2 /);
  assert.equal(r.cmp.notices.length, 3); /* the third: box 1 is rented but has no services entry */
});

test('a PMB repeated at the top of a page is merged quietly; a repeat elsewhere is flagged', () => {
  const carried = PMB.parseServices(services([[['101', 'Alex Example', PM]], [['101', 'Alex Example', NS], ['102', 'Sam Sample', NS]]]));
  assert.equal(carried.pmbs.length, 2);
  assert.deepEqual([...carried.pmbs[0].services], [PM, NS]);
  assert.equal(carried.repeated.length, 0);
  const mid = PMB.parseServices(services([[['101', 'Alex Example', PM], ['102', 'Sam Sample', NS], ['101', 'Alex Example', NS]]]));
  assert.equal(mid.repeated.length, 1);
  const otherName = PMB.parseServices(services([[['101', 'Alex Example', PM]], [['101', 'Someone Else', NS]]]));
  assert.equal(otherName.repeated.length, 1);
});

test('self-checks: amount total, page count, cross-report reconciliation', () => {
  assert.match(PMB.mailboxChecks(PMB.parseMailboxes(mailbox([['1', 'Past Due', 'A', '120.00']], 99900)))[0].text, /add up to \$120\.00/);
  const two = services([[['1', 'A', NS]], [['2', 'B', NS]]]);
  assert.ok(PMB.servicesChecks(PMB.parseServices(two.slice(0, 1))).some(n => n.cls === 'error'));
  const r = run(mailbox([['1', 'Current', 'A'], ['2', 'Available']]), services([[['1', 'A', NS], ['2', 'Gone', NS], ['77', 'Nowhere', NS]]]));
  assert.equal(notice(r.cmp.notices, /not on the Mailbox Listing/).list, '77');
  assert.equal(notice(r.cmp.notices, /shows the box as Available/).list, '2');
  /* a service only held by boxes that aren't rented is still offered, with nothing under it */
  assert.deepEqual([...r.cmp.services].map(s => s.count), [1]);
});

test('services under an unreadable PMB line are not given to the PMB above it', () => {
  const sv = PMB.parseServices(services([[['101', 'Alex Example', PM], ['10 2 B', 'Sam Sample', PM], [null, null, NS], ['103', 'Jo Demo', PM]]]));
  assert.equal(sv.unread.length, 1);
  assert.deepEqual([...sv.pmbs.find(p => p.box === '101').services], [PM]);
  assert.equal(sv.orphans.length, 1);
  const notes = PMB.servicesChecks(sv);
  assert.equal(notice(notes, /could not be read as a PMB or a service/).cls, 'error');
  assert.equal(notice(notes, /no readable PMB line above/).cls, 'error');
});

test('text drawn as several runs reads the same as one run', () => {
  const split = (page, whole, at, gap) => page.flatMap(i => i.str !== whole ? [i] : [it(whole.slice(0, at), i.x, i.y), it(whole.slice(at).trimStart(), i.x + at * 4.6 + gap, i.y)]);
  const pages = services([[['101', 'Alex Example', NS], [null, null, PM]]]);
  /* "Notifi" + "cation Service" touching, and "Personal" + "Mail Box" a word gap apart */
  const sv = PMB.parseServices([split(split(pages[0], NS, 6, 0.4), PM, 8, 2.5)]);
  assert.deepEqual([...sv.pmbs[0].services], [NS, PM]);
  assert.equal(sv.unread.length, 0);
  const mb = PMB.parseMailboxes([split(mailbox([['101', 'Current', 'Alex Example']])[0], 'Alex Example', 7, 0.3)]);
  assert.equal(mb.boxes[0].customer, 'Alex Example');
});

test('box numbers printed differently within one report are called out, not quietly merged', () => {
  const r = run(mailbox([['05', 'Closed and Forwarding', 'Old Five'], ['5', 'Current', 'New Five']]), services([[['5', 'New Five', NS]]]));
  const n = notice(r.cmp.notices, /prints these box numbers differently/);
  assert.equal(n.cls, '');
  assert.equal(n.list, '05 and 5');
  assert.ok(!notice(r.cmp.notices, /both as Closed and Forwarding/));
  /* the same thing in the services report, even at the top of a page */
  const sv = PMB.parseServices(services([[['7', 'Alex Example', PM]], [['07', 'Alex Example', NS]]]));
  assert.match(notice(PMB.servicesChecks(sv), /more than once in the PMB Services Report/).list, /^07 \(page 2, first printed as 7\)$/);
});

test('a mailbox line that cannot be read is an error that says the box is left out', () => {
  const pages = mailbox([['101', 'Current', 'Alex Example'], ['102', 'Current', 'Sam Sample']]);
  pages[0] = pages[0].filter(i => !(i.str === 'Current' && i.y === 640)); /* box 101 loses its status */
  const mb = PMB.parseMailboxes(pages);
  assert.equal(labels(mb.boxes), '102');
  const n = notice(PMB.mailboxChecks(mb), /could not be read/);
  assert.equal(n.cls, 'error');
  assert.match(n.text, /left out of both lists/);
  /* an amount that cannot be read shows up as a total that does not add up */
  const bad = mailbox([['1', 'Past Due', 'Alex Example', '120.00']]);
  bad[0].find(i => i.str === '120.00').str = '12O.00';
  assert.equal(notice(PMB.mailboxChecks(PMB.parseMailboxes(bad)), /add up to \$0\.00/).cls, 'error');
});

const HEADINGS = ['PMB', 'Boxholder Name', 'Company', 'Service Description', 'Nbr', 'Size/Type', 'Status', 'Customer (Current or Last)', 'Date Closed', 'Term', 'Due Date', 'Amount'];

test('a Mailbox Listing cut short, out of sequence or without headings is an error', () => {
  const whole = mailbox([['101', 'Current', 'Alex Example']]);
  const noTotal = [whole[0].filter(i => !/^Total Amount Due|^\$/.test(i.str))];
  assert.equal(notice(PMB.mailboxChecks(PMB.parseMailboxes(noTotal)), /No "Total Amount Due" line/).cls, 'error');
  const pageTwoOnly = [whole[0].map(i => i.str === '1' && i.x === 570 ? { ...i, str: '2' } : i)];
  assert.equal(notice(PMB.mailboxChecks(PMB.parseMailboxes(pageTwoOnly)), /page numbers do not run from 1/).cls, 'error');
  const second = mailbox([['102', 'Current', 'Sam Sample']])[0].filter(i => !HEADINGS.includes(i.str)).map(i => i.str === '1' && i.x === 570 ? { ...i, str: '2' } : i);
  const headless = PMB.parseMailboxes([noTotal[0], second]);
  assert.equal(notice(PMB.mailboxChecks(headless), /column headings were not found/).list, '2');
});

test('a PMB Services Report with no page count is an error', () => {
  const pages = services([[['101', 'Alex Example', NS]]]);
  pages[0] = pages[0].filter(i => !/^Page \d+ of/.test(i.str));
  assert.equal(notice(PMB.servicesChecks(PMB.parseServices(pages)), /No "Page 1 of/).cls, 'error');
});

test('different dates, a missing date, a filtered listing and an unknown status are each called out', () => {
  const mbP = mailbox([['101', 'Suspended', 'Alex Example'], ['102', 'AVAILABLE']]);
  mbP[0].find(i => i.str === 'Includes All Mailboxes').str = 'Includes Rented Mailboxes';
  mbP[0].find(i => /11:30 AM/.test(i.str)).str = '11/13/2026 9:05 AM';
  const mb = PMB.parseMailboxes(mbP), sv = PMB.parseServices(services([[['101', 'Alex Example', NS]]]));
  const cmp = PMB.compare(mb, sv);
  assert.ok(notice(cmp.notices, /created on different dates/));
  assert.equal(notice(cmp.notices, /statuses this tool does not know \(Suspended\)/).list, '101');
  assert.equal(cmp.rented.length, 1);
  assert.equal(cmp.vacantCount, 1);
  assert.ok(notice(PMB.mailboxChecks(mb), /says "Includes Rented Mailboxes"/));
  const undated = mailbox([['101', 'Current', 'Alex Example']]);
  undated[0] = undated[0].filter(i => !/11:30 AM/.test(i.str));
  assert.ok(notice(PMB.mailboxChecks(PMB.parseMailboxes(undated)), /date this Mailbox Listing was created could not be found/));
});

test('the same PMB on two lines in a row mid-page is flagged, not treated as a page-break repeat', () => {
  const sv = PMB.parseServices(services([[['100', 'Jo Demo', PM], ['101', 'Alex Example', PM], ['101', 'Alex Example', NS]]]));
  assert.equal(sv.repeated.length, 1);
});

test('a long customer name that swallows the Term column loses the term, not the name', () => {
  const pages = mailbox([['101', 'Current', 'Alex Example']]);
  pages[0] = pages[0].filter(i => i.str !== '12 month').map(i => i.str === 'Alex Example' ? it('Alexandria Example-Placeholder Holdings 12 month', i.x, i.y) : i);
  assert.equal(PMB.parseMailboxes(pages).boxes[0].customer, 'Alexandria Example-Placeholder Holdings');
});

test('text left of the Nbr column makes a mailbox line unread instead of being dropped', () => {
  const pages = mailbox([['101', 'Current', 'Alex Example']]);
  pages[0].push(it('*', 12, 640));
  const mb = PMB.parseMailboxes(pages);
  assert.equal(mb.boxes.length, 0);
  assert.match(mb.unread[0].text, /^\* 101 /);
});

test('the report kind comes from its title, and the services title wins', () => {
  assert.equal(PMB.kindOf(mailbox([['101', 'Current', 'Alex Example']])), 'mailbox');
  assert.equal(PMB.kindOf(services([[['101', 'Alex Example', 'Mailbox Listing']]])), 'services');
  assert.equal(PMB.kindOf([[it('Some Other Report', 20, 700)]]), null);
});

test('word gaps survive wide capitals, letter-spacing and the PDF reader\'s own space markers', () => {
  const at = (str, x, y, w) => ({ str, x, y, w });
  const name = runs => {
    const pages = mailbox([['101', 'Current', 'Placeholder']]);
    pages[0] = pages[0].filter(i => i.str !== 'Placeholder').concat(runs.map(([str, x, w]) => at(str, x, 640, w)));
    return PMB.parseMailboxes(pages).boxes[0].customer;
  };
  /* a wide capital followed by a real space */
  assert.equal(name([['W', 219, 9.44], ['Example', 219 + 9.44 + 2.78, 32]]), 'W Example');
  /* narrow letters spaced a little apart are still one word */
  assert.equal(name([['Jill', 219, 10.5], ['ian Sample', 219 + 10.5 + 1.1, 44]]), 'Jillian Sample');
  /* a whitespace-only item is a space however small the gap looks */
  assert.equal(name([['Alex', 219, 18.4], [' ', 237.4, 0], ['Example', 237.5, 32]]), 'Alex Example');
  /* even when it sits at exactly the x of the run after it, whichever order they arrive in */
  assert.equal(name([['Alex', 219, 18.4], [' ', 237.4, 0], ['Example', 237.4, 32]]), 'Alex Example');
  assert.equal(name([['Alex', 219, 18.4], ['Example', 237.4, 32], [' ', 237.4, 0]]), 'Alex Example');
  const sv = PMB.parseServices(services([[['101', 'Alex Example', 'Placeholder']]]).map(p => p.filter(i => i.str !== 'Placeholder').concat([at('WWW', 425, 689, 28.3), at('Mail', 425 + 28.3 + 2.5, 689, 17)])));
  assert.deepEqual([...sv.pmbs[0].services], ['WWW Mail']);
  /* a stray space item on its own line, or in another column, changes nothing */
  const pages = mailbox([['101', 'Current', 'Alex Example']]);
  pages[0].push(at(' ', 300, 500, 2.5), at(' ', 400, 628, 2.5));
  const mb = PMB.parseMailboxes(pages);
  assert.equal(mb.unread.length, 0);
  assert.equal(mb.boxes.length, 1);
});

test('a service typed with different capitals is one service, under its first spelling', () => {
  const r = run(mailbox([['101', 'Current', 'Alex Example'], ['102', 'Current', 'Sam Sample']]), services([[['101', 'Alex Example', NS], ['102', 'Sam Sample', 'NOTIFICATION SERVICE']]]));
  assert.deepEqual([...r.cmp.services].map(s => [s.name, s.count]), [[NS, 2]]);
});

test('the copied list is tab-separated, says None, and cannot be read as a formula', () => {
  const r = run(mailbox([['101', 'Current', '=Alex Example'], ['102', 'Past Due', 'Sam Sample', '95.00'], ['103', 'Current', 'Jo Demo']]),
    services([[['101', '=Alex Example', '@Demo Service'], ['102', 'Sam Sample', '--NONE--']]]));
  r.cmp.rented[1].company = '+Sample\tHarbor Co';
  const lines = PMB.listText(r.cmp.rented).split('\n').map(l => l.split('\t'));
  assert.deepEqual(lines[0], ['Box', 'Customer', 'Company', 'Status', 'Size/Type', 'Services on the box']);
  assert.deepEqual(lines[1], ['101', "'=Alex Example", '', 'Current', 'Basic', "'@Demo Service"]);
  assert.deepEqual(lines[2], ['102', 'Sam Sample', "'+Sample Harbor Co", 'Past Due', 'Basic', 'None']);
  assert.deepEqual(lines[3], ['103', 'Jo Demo', '', 'Current', 'Basic', 'Not in the services report']);
});
