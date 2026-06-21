const { chromium } = require('playwright');
const fs = require('fs');

const CANVA_URL = 'https://www.canva.com/design/DAHHhHnjj2M/oEPQa0XCe7iMRugy6ttYrg/view';

const TIME_SLOTS = [
  '9AM - 10AM','10AM - 11AM','11AM - 12PM',
  '12PM - 1PM','1PM - 2PM','2PM - 3PM',
  '3PM - 4PM','4PM - 5PM'
];

const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday'];

function extractWeekTitle(titleSpans) {
  const joined = titleSpans.join(' ');
  const m = joined.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d+)\s*[-–]\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d+,?\s*\d{4})/i);
  return m ? m[0].trim() : null;
}

async function extractSlideGeometry(page) {
  return await page.evaluate(() => {
    const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
    const DAY_PATTERNS = [/monday/i,/tuesday/i,/wednesday/i,/thursday/i,/friday/i];
    const SKIP_RE = /^(staff|student\s*staff|2nd\s*floor|ops|urp|pha|cpd|nsf|exp|open\s*shift|\d+(am|pm)\s*-\s*\d+(am|pm))/i;

    const results = [];
    const panes = document.querySelectorAll('._mXnjA');

    panes.forEach(pane => {
      if (pane.getAttribute('aria-hidden') === 'true') return;

      const titleSpans = Array.from(pane.querySelectorAll('span.a_GcMg'))
        .map(s => s.innerText.trim()).filter(t => t.length > 1);

      const table = pane.querySelector('table');
      if (!table) return;

      const tableRect = table.getBoundingClientRect();
      if (tableRect.height < 10) return;

      const allCells = Array.from(table.querySelectorAll('td, th'));

      // Col headers
      const colHeaders = allCells
        .filter(c => /^(staff|student\s*staff)$/i.test(c.innerText.replace(/\s+/g,' ').trim()))
        .map(c => {
          const r = c.getBoundingClientRect();
          return {
            role: /student/i.test(c.innerText) ? 'student' : 'staff',
            left: Math.round(r.left - tableRect.left),
            right: Math.round(r.right - tableRect.left),
            centerX: Math.round((r.left + r.right) / 2 - tableRect.left)
          };
        }).sort((a,b) => a.left - b.left);

      // Day headers — FIX: don't use Set.add() in filter, use separate tracking
      const daysSeen = {};
      const dayHeaders = [];
      allCells.forEach(c => {
        const text = c.innerText.replace(/\s+/g,' ').trim();
        let dayName = null;
        DAY_NAMES.forEach((d,i) => { if (DAY_PATTERNS[i].test(text)) dayName = d; });
        if (!dayName) return;
        if (daysSeen[dayName]) return;
        daysSeen[dayName] = true;
        const r = c.getBoundingClientRect();
        const dateM = text.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d+)/i);
        dayHeaders.push({
          dayName,
          date: dateM ? dateM[1].replace(/\s+/,' ').trim() : null,
          left: Math.round(r.left - tableRect.left),
          right: Math.round(r.right - tableRect.left),
          top: Math.round(r.top - tableRect.top)
        });
      });
      dayHeaders.sort((a,b) => a.left - b.left);

      // Named cells — not headers, not times, not day names
      const seen = {};
      const namedCells = [];
      allCells.forEach(c => {
        const text = c.innerText.replace(/\s+/g,' ').trim();
        if (!text || text.length < 2) return;
        if (SKIP_RE.test(text)) return;
        if (DAY_PATTERNS.some(p => p.test(text))) return;
        if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d+/i.test(text)) return;
        if (/^\(/.test(text)) return;
        const r = c.getBoundingClientRect();
        const relLeft = Math.round(r.left - tableRect.left);
        const relTop = Math.round(r.top - tableRect.top);
        const key = relLeft + ',' + relTop + ',' + text.slice(0,15);
        if (seen[key]) return;
        seen[key] = true;
        namedCells.push({
          text,
          left: relLeft,
          top: relTop,
          width: Math.round(r.width),
          height: Math.round(r.height),
          right: Math.round(r.right - tableRect.left),
          bottom: Math.round(r.bottom - tableRect.top)
        });
      });
      namedCells.sort((a,b) => Math.abs(a.top-b.top)>5 ? a.top-b.top : a.left-b.left);

      results.push({
        titleSpans,
        tableWidth: Math.round(tableRect.width),
        tableHeight: Math.round(tableRect.height),
        colHeaders,
        dayHeaders,
        namedCells
      });
    });

    return results;
  });
}

function parseSlideGeometry(slideData) {
  const { titleSpans, tableHeight, colHeaders, dayHeaders, namedCells } = slideData;

  if (!dayHeaders.length) { console.log('  SKIP: no day headers'); return null; }
  if (!colHeaders.length) { console.log('  SKIP: no col headers'); return null; }
  if (!namedCells.length) { console.log('  SKIP: no named cells'); return null; }

  const week = extractWeekTitle(titleSpans);

  const schedule = {};
  dayHeaders.forEach(d => { schedule[d.dayName] = { date: d.date, staff: null, studentShifts: [] }; });

  // Estimate where data rows start — use bottom of day headers + col headers
  const dayHeaderMaxTop = Math.max(...dayHeaders.map(d => d.top));
  const headerHeight = dayHeaderMaxTop + (tableHeight * 0.06);
  const dataHeight = tableHeight - headerHeight;
  const slotHeight = dataHeight / 8;

  console.log(`  tableH=${tableHeight} headerH=${Math.round(headerHeight)} slotH=${Math.round(slotHeight)} days=${dayHeaders.map(d=>d.dayName).join(',')} cols=${colHeaders.map(c=>c.role+'@'+c.left).join(',')}`);

  function topToSlotIndex(t) {
    const offset = t - headerHeight;
    if (offset < 0) return 0;
    return Math.min(7, Math.floor(offset / slotHeight));
  }

  function bottomToSlotIndex(b) {
    const offset = b - headerHeight;
    if (offset <= 0) return 0;
    return Math.min(7, Math.ceil(offset / slotHeight) - 1);
  }

  namedCells.forEach(cell => {
    const cx = cell.left + cell.width / 2;

    // Match day
    let day = dayHeaders.find(d => cx >= d.left && cx <= d.right);
    if (!day) {
      let best = Infinity;
      dayHeaders.forEach(d => {
        const dc = (d.left + d.right) / 2;
        if (Math.abs(cx - dc) < best) { best = Math.abs(cx - dc); day = d; }
      });
    }
    if (!day) return;

    // Match col within day
    const dayCols = colHeaders
      .filter(col => col.centerX >= day.left - 5 && col.centerX <= day.right + 5)
      .sort((a,b) => a.left - b.left);

    let col = dayCols.find(c => cx >= c.left && cx <= c.right);
    if (!col && dayCols.length === 1) col = dayCols[0];
    if (!col && dayCols.length > 1) {
      const mid = (day.left + day.right) / 2;
      col = cx <= mid ? dayCols[0] : dayCols[dayCols.length - 1];
    }

    const role = col ? col.role : (cx < (day.left + day.right) / 2 ? 'staff' : 'student');
    const si = topToSlotIndex(cell.top);
    const ei = bottomToSlotIndex(cell.bottom);
    const startTime = TIME_SLOTS[si];
    const endTime = ei < 7 ? TIME_SLOTS[ei + 1] : null;

    console.log(`  "${cell.text.padEnd(22)}" ${day.dayName.padEnd(10)} ${role.padEnd(8)} top=${cell.top} h=${cell.height} ${si}->${ei} ${startTime}`);

    if (role === 'staff') {
      if (!schedule[day.dayName].staff) schedule[day.dayName].staff = cell.text;
    } else {
      const dup = schedule[day.dayName].studentShifts.some(s => s.name === cell.text && s.startTime === startTime);
      if (!dup) schedule[day.dayName].studentShifts.push({ startTime, endTime, name: cell.text });
    }
  });

  return { week, schedule };
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  console.log('Navigating...');
  await page.goto(CANVA_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('table', { timeout: 30000 });
  await page.waitForTimeout(2000);

  const totalPages = await page.evaluate(() => {
    const c = document.querySelector('[aria-valuemax]');
    return c ? parseInt(c.getAttribute('aria-valuemax')) : 15;
  });
  console.log(`Total slides: ${totalPages}`);

  const allSlides = [];
  const seen = {};

  async function collect() {
    await page.waitForTimeout(1500);
    const slides = await extractSlideGeometry(page);
    slides.forEach(s => {
      const key = s.titleSpans.join('|').slice(0,80) + '|' + s.namedCells.slice(0,2).map(c=>c.text).join('|');
      if (!seen[key] && s.namedCells.length > 0) {
        seen[key] = true;
        allSlides.push(s);
        console.log(`Captured: "${s.titleSpans[0] ? s.titleSpans[0].slice(0,50) : '?'}" days=[${s.dayHeaders.map(d=>d.dayName).join(',')}] cols=${s.colHeaders.length} cells=${s.namedCells.length}`);
      }
    });
  }

  await collect();
  for (let i = 1; i < totalPages; i++) {
    const btn = await page.$('[aria-label="Next page"]');
    if (!btn || await btn.getAttribute('aria-disabled') === 'true') break;
    await btn.click();
    await collect();
  }

  console.log(`\nSlides: ${allSlides.length}`);
  const schedules = allSlides.map((s,i) => {
    console.log(`\n--- Slide ${i+1} ---`);
    return parseSlideGeometry(s);
  }).filter(Boolean);

  const seenW = {};
  const unique = schedules.filter(s => {
    if (!s.week) return false;
    const k = s.week.toLowerCase().replace(/\s+/g,'');
    if (seenW[k]) return false;
    seenW[k] = true;
    return true;
  });

  const summary = unique.map(s => {
    const lines = [`Week of ${s.week}:`];
    DAY_NAMES.forEach(day => {
      const d = s.schedule[day];
      if (!d) return;
      const stu = (d.studentShifts||[]).map(sh=>`${sh.name} ${sh.startTime}${sh.endTime?' until '+sh.endTime:'+'}`).join(', ')||'none';
      lines.push(`  ${day} (${d.date}): Staff=${d.staff||'TBD'} | Students=${stu}`);
    });
    return lines.join('\n');
  }).join('\n\n');

  console.log('\n=== SUMMARY ===\n' + summary);

  fs.writeFileSync('schedule.json', JSON.stringify({
    lastUpdated: new Date().toISOString(),
    source: CANVA_URL,
    totalWeeks: unique.length,
    schedules: unique,
    summary
  }, null, 2));
  console.log('\nDone.');
  await browser.close();
})();
