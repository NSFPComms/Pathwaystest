const { chromium } = require('playwright');
const fs = require('fs');

const CANVA_URL = 'https://www.canva.com/design/DAHHhHnjj2M/oEPQa0XCe7iMRugy6ttYrg/view';

const TIME_SLOTS = [
  '9AM - 10AM','10AM - 11AM','11AM - 12PM',
  '12PM - 1PM','1PM - 2PM','2PM - 3PM',
  '3PM - 4PM','4PM - 5PM'
];

function extractWeekTitle(titleSpans) {
  const joined = titleSpans.join(' ');
  const m = joined.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d+)\s*[-–]\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d+,?\s*\d{4})/i);
  return m ? m[0].trim() : null;
}

async function extractSlideGeometry(page) {
  return await page.evaluate(() => {
    const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
    const DAY_PATTERNS = [/monday/i,/tuesday/i,/wednesday/i,/thursday/i,/friday/i];
    const SKIP_RE = /^(staff|student\s*staff|2nd\s*floor|ops|urp|pha|cpd|nsf|exp|open\s*shift|monday|tuesday|wednesday|thursday|friday|\d+(am|pm)\s*-\s*\d+(am|pm))/i;

    const results = [];
    const panes = document.querySelectorAll('._mXnjA');

    panes.forEach(pane => {
      if (pane.getAttribute('aria-hidden') === 'true') return;

      const titleSpans = Array.from(pane.querySelectorAll('p._28USrA span.a_GcMg'))
        .map(s => s.innerText.trim()).filter(t => t.length > 1);

      const table = pane.querySelector('table');
      if (!table) return;

      const tableRect = table.getBoundingClientRect();
      if (tableRect.height < 10) return;

      const allTds = Array.from(table.querySelectorAll('td'));

      // Col headers (STAFF / STUDENT STAFF)
      const colHeaders = allTds
        .filter(td => /^(staff|student\s*staff)$/i.test(td.innerText.replace(/\s+/g,' ').trim()))
        .map(td => {
          const r = td.getBoundingClientRect();
          return {
            role: /student/i.test(td.innerText) ? 'student' : 'staff',
            left: Math.round(r.left - tableRect.left),
            right: Math.round(r.right - tableRect.left),
            centerX: Math.round((r.left + r.right) / 2 - tableRect.left)
          };
        }).sort((a,b) => a.left - b.left);

      // Day headers
      const seenDays = new Set();
      const dayHeaders = allTds
        .filter(td => DAY_PATTERNS.some(p => p.test(td.innerText)))
        .map(td => {
          const r = td.getBoundingClientRect();
          const text = td.innerText.replace(/\s+/g,' ').trim();
          let dayName = null;
          DAY_NAMES.forEach((d,i) => { if (DAY_PATTERNS[i].test(text)) dayName = d; });
          const dateM = text.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d+)/i);
          return {
            dayName,
            date: dateM ? dateM[1].replace(/\s+/,' ').trim() : null,
            left: Math.round(r.left - tableRect.left),
            right: Math.round(r.right - tableRect.left)
          };
        })
        .filter(d => d.dayName && !seenDays.has(d.dayName) && !seenDays.add(d.dayName))
        .sort((a,b) => a.left - b.left);

      // Named cells
      const seen = new Set();
      const namedCells = allTds
        .filter(td => {
          const text = td.innerText.replace(/\s+/g,' ').trim();
          if (!text || text.length < 2) return false;
          if (SKIP_RE.test(text)) return false;
          if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d+/i.test(text)) return false;
          if (/^\(/.test(text)) return false;
          return true;
        })
        .map(td => {
          const r = td.getBoundingClientRect();
          const text = td.innerText.replace(/\s+/g,' ').trim();
          const relLeft = Math.round(r.left - tableRect.left);
          const relTop = Math.round(r.top - tableRect.top);
          const key = relLeft + ',' + relTop + ',' + text.slice(0,15);
          if (seen.has(key)) return null;
          seen.add(key);
          return {
            text,
            left: relLeft,
            top: relTop,
            width: Math.round(r.width),
            height: Math.round(r.height),
            right: Math.round(r.right - tableRect.left),
            bottom: Math.round(r.bottom - tableRect.top)
          };
        })
        .filter(Boolean)
        .sort((a,b) => Math.abs(a.top-b.top)>5 ? a.top-b.top : a.left-b.left);

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
  const { titleSpans, tableWidth, tableHeight, colHeaders, dayHeaders, namedCells } = slideData;
  if (!dayHeaders.length || !colHeaders.length || !namedCells.length) return null;

  const week = extractWeekTitle(titleSpans);

  const schedule = {};
  dayHeaders.forEach(d => { schedule[d.dayName] = { date: d.date, staff: null, studentShifts: [] }; });

  // Estimate header height from where the col headers sit
  // Data area starts after the col header row bottom
  // We'll approximate: find the lowest col header bottom
  // Since we don't have bottom of colHeaders easily, use 15% fallback
  const headerFraction = 0.155;
  const headerHeight = tableHeight * headerFraction;
  const dataHeight = tableHeight - headerHeight;
  const slotHeight = dataHeight / 8;

  function topToSlotIndex(relTop) {
    const offset = relTop - headerHeight;
    if (offset < 0) return 0;
    return Math.min(7, Math.floor(offset / slotHeight));
  }

  function bottomToSlotIndex(relBottom) {
    const offset = relBottom - headerHeight;
    if (offset <= 0) return 0;
    return Math.min(7, Math.round(offset / slotHeight) - 1);
  }

  namedCells.forEach(cell => {
    const cellCenterX = cell.left + cell.width / 2;

    // Match day by x overlap
    let matchedDay = dayHeaders.find(d => cellCenterX >= d.left && cellCenterX <= d.right);
    if (!matchedDay) {
      // closest day
      let minDist = Infinity;
      dayHeaders.forEach(d => {
        const c = (d.left + d.right) / 2;
        if (Math.abs(cellCenterX - c) < minDist) { minDist = Math.abs(cellCenterX - c); matchedDay = d; }
      });
    }
    if (!matchedDay) return;

    // Match col header by x overlap within this day's range
    let matchedCol = colHeaders.find(col =>
      cellCenterX >= col.left && cellCenterX <= col.right &&
      col.centerX >= matchedDay.left && col.centerX <= matchedDay.right
    );

    if (!matchedCol) {
      // Find col headers belonging to this day, pick closest
      const dayCols = colHeaders
        .filter(col => col.centerX >= matchedDay.left && col.centerX <= matchedDay.right)
        .sort((a,b) => a.left - b.left);

      if (dayCols.length === 1) {
        matchedCol = dayCols[0];
      } else if (dayCols.length > 1) {
        // Left col = staff, right col = student (per design)
        const dayMidX = (matchedDay.left + matchedDay.right) / 2;
        matchedCol = cellCenterX < dayMidX ? dayCols[0] : dayCols[dayCols.length - 1];
      }
    }

    const role = matchedCol ? matchedCol.role : 'staff';

    const startSlotIdx = topToSlotIndex(cell.top);
    const endSlotIdx = bottomToSlotIndex(cell.bottom);
    const startTime = TIME_SLOTS[startSlotIdx];
    // End time: the slot AFTER the last covered slot
    const endTime = endSlotIdx < 7 ? TIME_SLOTS[endSlotIdx + 1] : null;

    console.log(`  "${cell.text.padEnd(25)}" day=${matchedDay.dayName.padEnd(10)} role=${role.padEnd(8)} h=${cell.height} startSlot=${startSlotIdx}(${startTime}) endSlot=${endSlotIdx}`);

    if (!schedule[matchedDay.dayName]) return;

    if (role === 'staff') {
      if (!schedule[matchedDay.dayName].staff) {
        schedule[matchedDay.dayName].staff = cell.text;
      }
    } else {
      const dup = schedule[matchedDay.dayName].studentShifts
        .some(s => s.name === cell.text && s.startTime === startTime);
      if (!dup) {
        schedule[matchedDay.dayName].studentShifts.push({ startTime, endTime, name: cell.text });
      }
    }
  });

  return { week, schedule };
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('Navigating to Canva...');
  await page.goto(CANVA_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('table', { timeout: 30000 });
  await page.waitForTimeout(2000);

  const totalPages = await page.evaluate(() => {
    const counter = document.querySelector('[aria-valuemax]');
    return counter ? parseInt(counter.getAttribute('aria-valuemax')) : 15;
  });
  console.log(`Total slides: ${totalPages}`);

  const allSlides = [];
  const seen = new Set();

  async function collectSlide() {
    await page.waitForTimeout(1500);
    const slides = await extractSlideGeometry(page);
    slides.forEach(s => {
      const key = s.titleSpans.slice(0,2).join('|') + '|' + s.namedCells.slice(0,3).map(c=>c.text).join('|');
      if (!seen.has(key) && s.namedCells.length > 0) {
        seen.add(key);
        allSlides.push(s);
        console.log(`Captured: ${s.titleSpans.slice(0,2).join(' ')} | days=${s.dayHeaders.map(d=>d.dayName).join(',')} | cols=${s.colHeaders.map(c=>c.role+'@'+c.left).join(',')}`);
      }
    });
  }

  await collectSlide();
  for (let i = 1; i < totalPages; i++) {
    const nextBtn = await page.$('[aria-label="Next page"]');
    if (!nextBtn) break;
    if (await nextBtn.getAttribute('aria-disabled') === 'true') break;
    await nextBtn.click();
    await collectSlide();
  }

  console.log(`\nTotal slides: ${allSlides.length}`);

  const schedules = allSlides.map(s => {
    console.log(`\n--- ${s.titleSpans.slice(0,2).join(' ')} ---`);
    return parseSlideGeometry(s);
  }).filter(Boolean);

  // Deduplicate
  const seenWeeks = new Set();
  const unique = schedules.filter(s => {
    if (!s.week) return false;
    const key = s.week.toLowerCase().replace(/\s+/g,'');
    if (seenWeeks.has(key)) return false;
    seenWeeks.add(key);
    return true;
  });

  const summary = unique.map(s => {
    const lines = [`Week of ${s.week}:`];
    ['Monday','Tuesday','Wednesday','Thursday','Friday'].forEach(day => {
      const d = s.schedule[day];
      if (!d) return;
      const students = (d.studentShifts||[]).map(sh => `${sh.name} ${sh.startTime}${sh.endTime?' until '+sh.endTime:'+'}`).join(', ') || 'none';
      lines.push(`  ${day} (${d.date}): Staff=${d.staff||'TBD'} | Students=${students}`);
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

  console.log('\nschedule.json written.');
  await browser.close();
})();
