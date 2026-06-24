const { chromium } = require('playwright');
const fs = require('fs');

const CANVA_URL = 'https://www.canva.com/design/DAHHhHnjj2M/oEPQa0XCe7iMRugy6ttYrg/view';
const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday'];

function offsetToTimeStr(hoursFrom9AM) {
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

      // Named cells — raw float heights
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
        const relTop = r.top - tableRect.top;
        const key = relLeft + ',' + Math.round(relTop) + ',' + text.slice(0,15);
        if (seenNamed[key]) return;
        seenNamed[key] = true;
        namedCells.push({
          text,
          left: relLeft,
          top: relTop,
          width: r.width,
          height: r.height,
          right: r.right - tableRect.left,
          bottom: r.bottom - tableRect.top
        });
      });
      namedCells.sort((a,b) => Math.abs(a.top-b.top)>1 ? a.top-b.top : a.left-b.left);

      // Empty cells — raw floats
      const seenEmpty = {};
      const emptyCells = [];
      allCells.forEach(c => {
        const text = c.innerText.replace(/\s+/g,' ').trim();
        if (text) return;
        const r = c.getBoundingClientRect();
        if (r.height <= 0 || r.width <= 0) return;
        const key = Math.round(r.left - tableRect.left) + ',' + Math.round(r.top - tableRect.top) + ',' + Math.round(r.height * 100);
        if (seenEmpty[key]) return;
        seenEmpty[key] = true;
        emptyCells.push({
          left: r.left - tableRect.left,
          top: r.top - tableRect.top,
          width: r.width,
          height: r.height,
          right: r.right - tableRect.left,
          bottom: r.bottom - tableRect.top
        });
      });

      results.push({ titleSpans, tableHeight: tableRect.height, colHeaders, dayHeaders, namedCells, emptyCells });
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

  function pixelToHours(px) {
    return (px - headerHeight) / slotHeight;
  }

  // Half-hour detection via gap-splitting between consecutive cells in the same column.
  // At Playwright scale (tableH=20, slotH=2), a half-hour gap (real: 15.21px)
  // renders as exactly 1px = 0.5 slots. But it shows up as empty cells of h=2 (1 full slot)
  // because Canva's table merges sub-pixel rows. Instead, we detect the gap BETWEEN
  // consecutive named cells in the same x-column:
  //   - gap = 1 slot (slotH): likely a half-hour gap — split it, each cell gets 0.5 slots
  //   - gap = 0: cells are contiguous — no adjustment
  //   - gap > 1 slot: real gap (e.g. lunch break) — no half-hour adjustment

  const halfHourAdjustments = new Map(); // Maps cell → { top?, bottom? }

  // Group cells by approximate x-center (same column = within 3px)
  const colGroups = [];
  namedCells.forEach(cell => {
    const cx = cell.left + cell.width / 2;
    let g = colGroups.find(g => Math.abs(g.cx - cx) < 3);
    if (!g) { g = { cx, cells: [] }; colGroups.push(g); }
    g.cells.push(cell);
  });

  colGroups.forEach(group => {
    const sorted = group.cells.slice().sort((a,b) => a.top - b.top);
    for (let i = 0; i < sorted.length - 1; i++) {
      const curr = sorted[i];
      const next = sorted[i+1];
      const currBottom = curr.top + curr.height;
      const gap = next.top - currBottom;
      // A half-hour gap renders as exactly 1 slot (slotH) at Playwright scale.
      // We only split it if an empty cell occupies that exact space — confirming
      // it's a real structural gap, not just missing student coverage.
      if (gap >= slotHeight * 0.4 && gap <= slotHeight * 1.2) {
        // Verify: is there an empty cell that fills this exact gap?
        const gapTop = currBottom;
        const gapBot = next.top;
        const hasEmptyFill = emptyCells.some(e => {
          const xOverlap = e.right > curr.left + 1 && e.left < curr.right - 1;
          const vertMatch = e.top >= gapTop - 0.5 && e.bottom <= gapBot + 0.5;
          return xOverlap && vertMatch;
        });
        if (hasEmptyFill) {
          const adjustedNextTop = currBottom + gap / 2;
          console.log('  ½hr gap: "' + next.text.trim() + '" start ' + next.top.toFixed(2) + '→' + adjustedNextTop.toFixed(2));
          halfHourAdjustments.set(next, Object.assign(halfHourAdjustments.get(next)||{}, { top: adjustedNextTop }));
        }
      }
    }

    // Case 2: lone cell with a half-slot empty cell directly above it
    // (e.g. Greyson alone, starts at 1:30PM with no one before him in column)
    for (let i = 0; i < sorted.length; i++) {
      const cell = sorted[i];
      if (halfHourAdjustments.has(cell)) continue; // already adjusted
      const spacerAbove = emptyCells.find(e => {
        const xOverlap = e.right > cell.left + 1 && e.left < cell.right - 1;
        const buttsUp = Math.abs(e.bottom - cell.top) <= 0.5;
        const isHalfSlot = e.height >= slotHeight * 0.4 && e.height <= slotHeight * 1.2;
        return xOverlap && buttsUp && isHalfSlot;
      });
      if (spacerAbove) {
        const adjustedTop = spacerAbove.top + spacerAbove.height / 2;
        console.log('  ½hr spacer above "' + cell.text.trim() + '": ' + cell.top.toFixed(2) + '→' + adjustedTop.toFixed(2));
        halfHourAdjustments.set(cell, Object.assign(halfHourAdjustments.get(cell)||{}, { top: adjustedTop }));
      }
    }
  });

  function getAdjustedTop(cell) {
    return halfHourAdjustments.get(cell)?.top ?? cell.top;
  }

  function getAdjustedBottom(cell) {
    return halfHourAdjustments.get(cell)?.bottom ?? cell.bottom;
  }

  console.log('  slotH=' + slotHeight.toFixed(3) + ' empty=' + emptyCells.length + ' heights=' + emptyCells.map(e=>e.height.toFixed(3)).join(','));

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

    console.log('  "' + cell.text.padEnd(22) + '" ' + day.dayName.padEnd(10) + ' ' + role.padEnd(8) + ' top=' + cell.top.toFixed(2) + '→' + adjTop.toFixed(2) + ' h=' + cell.height.toFixed(2) + ' ' + startTime + '-' + endTime);

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
  const page = await browser.newPage();
  await page.setViewportSize({ width: 3840, height: 2160 }); // 4K — forces Canva to render table at full size
  console.log('Navigating...');
  await page.goto(CANVA_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('table', { timeout: 30000 });
  await page.waitForTimeout(2000);

  const totalPages = await page.evaluate(() => {
    const c = document.querySelector('[aria-valuemax]');
    return c ? parseInt(c.getAttribute('aria-valuemax')) : 15;
  });
  console.log('Total slides: ' + totalPages);

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
        console.log('Captured: days=[' + s.dayHeaders.map(d=>d.dayName).join(',') + '] cells=' + s.namedCells.length + ' empty=' + s.emptyCells.length);
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

  const schedules = allSlides.map((s,i) => {
    console.log('\n--- Slide ' + (i+1) + ' ---');
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
    const lines = ['Week of ' + s.week + ':'];
    DAY_NAMES.forEach(day => {
      const d = s.schedule[day];
      if (!d) return;
      const staffStr = d.staff || 'No staff assigned';
      const stuStr = (d.studentShifts||[]).length
        ? d.studentShifts.map(sh => sh.name + ' ' + sh.startTime + '-' + sh.endTime).join(', ')
        : 'No student staff assigned';
      lines.push('  ' + day + ' (' + d.date + '): Staff=' + staffStr + ' | Students=' + stuStr);
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
