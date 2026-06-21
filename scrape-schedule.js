const { chromium } = require('playwright');
const fs = require('fs');

const CANVA_URL = 'https://www.canva.com/design/DAHHhHnjj2M/oEPQa0XCe7iMRugy6ttYrg/view';
const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday'];

function offsetToTimeStr(hoursFrom9AM) {
  // Snap to nearest 30 minutes
  const totalMins = Math.round(hoursFrom9AM * 2) * 30;
  const hour = 9 + Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour > 12 ? hour - 12 : (hour === 12 ? 12 : hour);
  return mins === 0 ? `${h12}${ampm}` : `${h12}:${String(mins).padStart(2,'0')}${ampm}`;
}

function extractWeekTitle(titleSpans) {
  const joined = titleSpans.join(' ');
  const m = joined.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d+)\s*[-–]\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d+,?\s*\d{4})/i);
  return m ? m[0].trim() : null;
}

async function extractSlideGeometry(page) {
  return await page.evaluate(() => {
    const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
    const DAY_PATTERNS = [/monday/i,/tuesday/i,/wednesday/i,/thursday/i,/friday/i];
    const SKIP_RE = /^(staff|student\s*staff|2nd\s*floor|\d+(am|pm)\s*-\s*\d+(am|pm))/i;

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

      // Day headers
      const daysSeen = {};
      const dayHeaders = [];
      allCells.forEach(c => {
        const text = c.innerText.replace(/\s+/g,' ').trim();
        let dayName = null;
        DAY_NAMES.forEach((d,i) => { if (DAY_PATTERNS[i].test(text)) dayName = d; });
        if (!dayName || daysSeen[dayName]) return;
        daysSeen[dayName] = true;
        const r = c.getBoundingClientRect();
        const dateM = text.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d+)/i);
        dayHeaders.push({
          dayName,
          date: dateM ? dateM[1].replace(/\s+/,' ').trim() : null,
          left: Math.round(r.left - tableRect.left),
          right: Math.round(r.right - tableRect.left),
        });
      });
      dayHeaders.sort((a,b) => a.left - b.left);

      // Named cells (unchanged from working version)
      const seenNamed = {};
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
        if (seenNamed[key]) return;
        seenNamed[key] = true;
        namedCells.push({
          text,
          left: relLeft, top: relTop,
          width: Math.round(r.width), height: Math.round(r.height),
          right: Math.round(r.right - tableRect.left),
          bottom: Math.round(r.bottom - tableRect.top)
        });
      });
      namedCells.sort((a,b) => Math.abs(a.top-b.top)>2 ? a.top-b.top : a.left-b.left);

      // Empty cells — use raw getBoundingClientRect values (no rounding)
      // At Playwright's scaled viewport, a half-hour gap ~= slotH/2 ~= 1px
      // We must accept ANY non-zero height
      const seenEmpty = {};
      const emptyCells = [];
      allCells.forEach(c => {
        const text = c.innerText.replace(/\s+/g,' ').trim();
        if (text) return;
        const r = c.getBoundingClientRect();
        if (r.height <= 0 || r.width <= 0) return; // truly zero — skip
        const relLeft = r.left - tableRect.left;
        const relTop = r.top - tableRect.top;
        const key = Math.round(relLeft) + ',' + Math.round(relTop) + ',' + Math.round(r.height * 100);
        if (seenEmpty[key]) return;
        seenEmpty[key] = true;
        emptyCells.push({
          left: relLeft, top: relTop,
          width: r.width, height: r.height,
          right: r.right - tableRect.left,
          bottom: r.bottom - tableRect.top
        });
      });

      console.log('DEBUG slide emptyCells=' + emptyCells.length + ' heights=' + emptyCells.slice(0,8).map(e=>e.height.toFixed(3)).join(','));
      results.push({ titleSpans, tableHeight: Math.round(tableRect.height), colHeaders, dayHeaders, namedCells, emptyCells });
    });

    return results;
  });
}

function parseSlideGeometry(slideData) {
  const { titleSpans, tableHeight, colHeaders, dayHeaders, namedCells, emptyCells } = slideData;
  if (!dayHeaders.length || !colHeaders.length || !namedCells.length) return null;

  const week = extractWeekTitle(titleSpans);
  const schedule = {};
  dayHeaders.forEach(d => { schedule[d.dayName] = { date: d.date, staff: null, studentShifts: [] }; });

  const headerHeight = Math.min(...namedCells.map(c => c.top));
  const maxCellHeight = Math.max(...namedCells.map(c => c.height));
  const slotHeight = maxCellHeight / 8;
  // Use raw table pixel dimensions for half-slot detection
  // tableHeight=20 means slotH=2, halfSlot=1 — but emptyCells use raw floats
  // so compare against slotHeight directly
  const halfSlot = slotHeight / 2;

  console.log(`  tableH=${tableHeight} headerH=${headerHeight} slotH=${slotHeight.toFixed(2)} halfSlot=${halfSlot.toFixed(2)} emptyCells=${emptyCells.length}`);

  function pixelToHours(px) {
    return (px - headerHeight) / slotHeight;
  }

  // Check for empty half-slot cell directly above a named cell
  // From the real HTML: full slot = 291.6px, half-hour gap = 15.21px = ~0.417 slots
  // At Playwright scale (tableH~20): slotH=2, halfSlot=1
  // The gap cell height ratio to slotH is: 15.21/36.45 = 0.417
  // So we detect a half-hour gap when empty cell height is between 25%-75% of slotHeight
  const halfSlotMin = slotHeight * 0.25;
  const halfSlotMax = slotHeight * 0.75;

  function getAdjustedTop(cell) {
    for (const e of emptyCells) {
      // x overlap: the empty cell must be in the same column
      const xOverlap = e.right > cell.left + 1 && e.left < cell.right - 1;
      // vertical: empty cell's bottom must be at or very near cell's top
      const buttsUp = Math.abs(e.bottom - cell.top) <= 0.6;
      // height: must be roughly half a slot
      const isHalfSlot = e.height >= halfSlotMin && e.height <= halfSlotMax;
      if (xOverlap && buttsUp && isHalfSlot) {
        console.log('    half-hr gap ABOVE "' + cell.text + '": emptyH=' + e.height.toFixed(3) + ' slotH=' + slotHeight.toFixed(3) + ' adjustedTop=' + e.top.toFixed(3));
        return e.top;
      }
    }
    return cell.top;
  }

  function getAdjustedBottom(cell) {
    for (const e of emptyCells) {
      const xOverlap = e.right > cell.left + 1 && e.left < cell.right - 1;
      const buttsDown = Math.abs(e.top - cell.bottom) <= 0.6;
      const isHalfSlot = e.height >= halfSlotMin && e.height <= halfSlotMax;
      if (xOverlap && buttsDown && isHalfSlot) {
        console.log('    half-hr gap BELOW "' + cell.text + '": emptyH=' + e.height.toFixed(3) + ' adjustedBottom=' + e.bottom.toFixed(3));
        return e.bottom;
      }
    }
    return cell.bottom;
  }

  namedCells.forEach(cell => {
    const cx = cell.left + cell.width / 2;

    let day = dayHeaders.find(d => cx >= d.left && cx <= d.right);
    if (!day) {
      let best = Infinity;
      dayHeaders.forEach(d => {
        const dc = (d.left + d.right) / 2;
        if (Math.abs(cx - dc) < best) { best = Math.abs(cx - dc); day = d; }
      });
    }
    if (!day) return;

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

    const adjTop = getAdjustedTop(cell);
    const adjBottom = getAdjustedBottom(cell);
    const startTime = offsetToTimeStr(pixelToHours(adjTop));
    const endTime = offsetToTimeStr(pixelToHours(adjBottom));

    console.log(`  "${cell.text.padEnd(22)}" ${day.dayName.padEnd(10)} ${role.padEnd(8)} top=${cell.top}→${adjTop} bot=${cell.bottom}→${adjBottom} ${startTime}-${endTime}`);

    if (!schedule[day.dayName]) return;

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
  // Large viewport so Canva renders the table at full resolution — essential for sub-pixel half-hour gap detection
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1600, height: 900 });
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
        console.log(`Captured: days=[${s.dayHeaders.map(d=>d.dayName).join(',')}] cells=${s.namedCells.length} empty=${s.emptyCells.length}`);
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

  console.log(`\nTotal slides: ${allSlides.length}`);
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
      const staffStr = d.staff || 'No staff assigned';
      const stuStr = (d.studentShifts||[]).length
        ? d.studentShifts.map(sh=>`${sh.name} ${sh.startTime}-${sh.endTime}`).join(', ')
        : 'No student staff assigned';
      lines.push(`  ${day} (${d.date}): Staff=${staffStr} | Students=${stuStr}`);
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
