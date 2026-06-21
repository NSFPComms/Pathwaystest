const { chromium } = require('playwright');
const fs = require('fs');

const CANVA_URL = 'https://www.canva.com/design/DAHHhHnjj2M/oEPQa0XCe7iMRugy6ttYrg/view';
const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday'];

function offsetToTimeStr(hoursFrom9AM) {
  const totalMins = Math.round(hoursFrom9AM * 30) * 2; // snap to nearest 30 mins
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

      // Named cells + empty data cells (for half-hour gap detection)
      const seenKeys = {};
      const namedCells = [];
      const emptyCells = []; // cells with no text but in the data area

      allCells.forEach(c => {
        const text = c.innerText.replace(/\s+/g,' ').trim();
        const r = c.getBoundingClientRect();
        const relLeft = Math.round(r.left - tableRect.left);
        const relTop = Math.round(r.top - tableRect.top);
        const relH = Math.round(r.height);
        const relW = Math.round(r.width);

        // Skip header cells and tiny/zero-size cells
        if (relH < 3 || relW < 5) return;

        const key = relLeft + ',' + relTop + ',' + text.slice(0,15);
        if (seenKeys[key]) return;
        seenKeys[key] = true;

        if (!text || SKIP_RE.test(text) || DAY_PATTERNS.some(p => p.test(text)) ||
            /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d+/i.test(text) ||
            /^\(/.test(text)) {
          // Could be an empty data cell — capture if it's in the data area
          // We'll filter by position later
          if (!text) {
            emptyCells.push({ left: relLeft, top: relTop, width: relW, height: relH,
              right: Math.round(r.right - tableRect.left), bottom: Math.round(r.bottom - tableRect.top) });
          }
          return;
        }

        namedCells.push({
          text,
          left: relLeft, top: relTop, width: relW, height: relH,
          right: Math.round(r.right - tableRect.left),
          bottom: Math.round(r.bottom - tableRect.top)
        });
      });

      namedCells.sort((a,b) => Math.abs(a.top-b.top)>2 ? a.top-b.top : a.left-b.left);

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
  const slotHeight = maxCellHeight / 8; // 8 one-hour slots (9AM-5PM)
  const halfSlot = slotHeight / 2;

  console.log(`  tableH=${tableHeight} headerH=${headerHeight} slotH=${slotHeight.toFixed(2)} halfSlot=${halfSlot.toFixed(2)}`);

  function pixelToHours(px) {
    return (px - headerHeight) / slotHeight;
  }

  // For a named cell, check if there's an empty cell directly above it
  // in the same x-column with height ~= halfSlot. If so, the real start
  // is at the TOP of that empty cell, not the top of the named cell.
  function getAdjustedStartTop(cell) {
    const tolerance = slotHeight * 0.35; // 35% tolerance for half-slot match
    const above = emptyCells.filter(e => {
      // Empty cell must be in roughly the same x range
      const xOverlap = e.left < cell.right - 2 && e.right > cell.left + 2;
      // Empty cell must end right where the named cell starts (within 3px)
      const buttsUp = Math.abs(e.bottom - cell.top) <= 3;
      // Height should be close to a half-slot
      const isHalfSlot = Math.abs(e.height - halfSlot) < tolerance;
      return xOverlap && buttsUp && isHalfSlot;
    });

    if (above.length > 0) {
      // Use the top of the empty cell as the real start
      const emptyCell = above[0];
      console.log(`    Half-hour gap detected above "${cell.text}": emptyTop=${emptyCell.top} h=${emptyCell.height} → start from empty top`);
      return emptyCell.top;
    }
    return cell.top;
  }

  // Similarly check if there's an empty cell directly below (for early endings)
  function getAdjustedEndBottom(cell) {
    const tolerance = slotHeight * 0.35;
    const below = emptyCells.filter(e => {
      const xOverlap = e.left < cell.right - 2 && e.right > cell.left + 2;
      const buttsDown = Math.abs(e.top - cell.bottom) <= 3;
      const isHalfSlot = Math.abs(e.height - halfSlot) < tolerance;
      return xOverlap && buttsDown && isHalfSlot;
    });

    if (below.length > 0) {
      const emptyCell = below[0];
      console.log(`    Half-hour gap detected below "${cell.text}": emptyBottom=${emptyCell.bottom} → end at empty bottom`);
      return emptyCell.bottom;
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

    // Adjust for half-hour gaps
    const adjustedTop = getAdjustedStartTop(cell);
    const adjustedBottom = getAdjustedEndBottom(cell);

    const startHours = pixelToHours(adjustedTop);
    const endHours = pixelToHours(adjustedBottom);
    const startTime = offsetToTimeStr(startHours);
    const endTime = offsetToTimeStr(endHours);

    console.log(`  "${cell.text.padEnd(22)}" ${day.dayName.padEnd(10)} ${role.padEnd(8)} top=${cell.top}(adj=${adjustedTop}) h=${cell.height} ${startTime}-${endTime}`);

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
