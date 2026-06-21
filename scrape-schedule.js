const { chromium } = require('playwright');
const fs = require('fs');

const CANVA_URL = 'https://www.canva.com/design/DAHHhHnjj2M/oEPQa0XCe7iMRugy6ttYrg/view';

const TIME_SLOTS = [
  '9AM - 10AM','10AM - 11AM','11AM - 12PM',
  '12PM - 1PM','1PM - 2PM','2PM - 3PM',
  '3PM - 4PM','4PM - 5PM'
];

const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
const DAY_PATTERNS = [/monday/i,/tuesday/i,/wednesday/i,/thursday/i,/friday/i];

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

      // Get title from ALL text spans in the pane — title may be at top or bottom
      const allSpans = Array.from(pane.querySelectorAll('span.a_GcMg'))
        .map(s => s.innerText.trim()).filter(t => t.length > 1);

      // Find week title specifically
      const titleSpans = allSpans.filter(t =>
        /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d+\s*[-–]\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d+/i.test(t) ||
        /pathways/i.test(t)
      );

      const table = pane.querySelector('table');
      if (!table) return;

      const tableRect = table.getBoundingClientRect();
      if (tableRect.height < 10) return;

      // Query BOTH td and th
      const allCells = Array.from(table.querySelectorAll('td, th'));

      // Debug: log all cell texts to find day headers
      const allCellTexts = allCells.map(c => c.innerText.replace(/\s+/g,' ').trim()).filter(t => t.length > 0);

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

      // Day headers — look for cells containing day names
      const seenDays = new Set();
      const dayHeaders = allCells
        .filter(c => DAY_PATTERNS.some(p => p.test(c.innerText)))
        .map(c => {
          const text = c.innerText.replace(/\s+/g,' ').trim();
          const r = c.getBoundingClientRect();
          let dayName = null;
          DAY_NAMES.forEach((d,i) => { if (DAY_PATTERNS[i].test(text)) dayName = d; });
          const dateM = text.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d+)/i);
          return {
            dayName,
            date: dateM ? dateM[1].replace(/\s+/,' ').trim() : null,
            left: Math.round(r.left - tableRect.left),
            right: Math.round(r.right - tableRect.left),
            top: Math.round(r.top - tableRect.top),
            text
          };
        })
        .filter(d => d.dayName && !seenDays.has(d.dayName) && !seenDays.add(d.dayName))
        .sort((a,b) => a.left - b.left);

      // Named cells — td/th that aren't headers or times
      const seen = new Set();
      const namedCells = allCells
        .filter(c => {
          const text = c.innerText.replace(/\s+/g,' ').trim();
          if (!text || text.length < 2) return false;
          if (SKIP_RE.test(text)) return false;
          if (DAY_PATTERNS.some(p => p.test(text))) return false;
          if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d+/i.test(text)) return false;
          if (/^\(/.test(text)) return false;
          return true;
        })
        .map(c => {
          const text = c.innerText.replace(/\s+/g,' ').trim();
          const r = c.getBoundingClientRect();
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
        allCellTexts: allCellTexts.slice(0, 30), // debug: first 30 cell texts
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

  if (!dayHeaders.length) {
    console.log('  SKIP: no day headers found');
    return null;
  }
  if (!colHeaders.length) {
    console.log('  SKIP: no col headers found');
    return null;
  }
  if (!namedCells.length) {
    console.log('  SKIP: no named cells');
    return null;
  }

  const week = extractWeekTitle(titleSpans);

  const schedule = {};
  dayHeaders.forEach(d => { schedule[d.dayName] = { date: d.date, staff: null, studentShifts: [] }; });

  // Calibrate header height from day header bottom position
  // Day headers are at the top, their bottom tells us where data starts
  const dayHeaderBottom = Math.max(...dayHeaders.map(d => d.top)) + 60; // approx

  // Find col header bottom to get data start more precisely
  // Use 15% as fallback
  const headerHeight = Math.max(dayHeaderBottom, tableHeight * 0.13);
  const dataHeight = tableHeight - headerHeight;
  const slotHeight = dataHeight / 8;

  console.log(`  tableH=${tableHeight} headerH=${Math.round(headerHeight)} slotH=${Math.round(slotHeight)}`);

  function topToSlotIndex(relTop) {
    const offset = relTop - headerHeight;
    if (offset < 0) return 0;
    return Math.min(7, Math.floor(offset / slotHeight));
  }

  function bottomToSlotIndex(relBottom) {
    const offset = relBottom - headerHeight;
    if (offset <= 0) return 0;
    return Math.min(7, Math.ceil(offset / slotHeight) - 1);
  }

  namedCells.forEach(cell => {
    const cellCenterX = cell.left + cell.width / 2;

    // Match day
    let matchedDay = dayHeaders.find(d => cellCenterX >= d.left && cellCenterX <= d.right);
    if (!matchedDay) {
      let minDist = Infinity;
      dayHeaders.forEach(d => {
        const c = (d.left + d.right) / 2;
        const dist = Math.abs(cellCenterX - c);
        if (dist < minDist) { minDist = dist; matchedDay = d; }
      });
    }
    if (!matchedDay) return;

    // Match col within this day
    const dayLeft = matchedDay.left;
    const dayRight = matchedDay.right;

    let matchedCol = colHeaders.find(col =>
      cellCenterX >= col.left && cellCenterX <= col.right &&
      col.centerX >= dayLeft - 5 && col.centerX <= dayRight + 5
    );

    if (!matchedCol) {
      const dayCols = colHeaders
        .filter(col => col.centerX >= dayLeft - 5 && col.centerX <= dayRight + 5)
        .sort((a,b) => a.left - b.left);

      if (dayCols.length === 1) {
        matchedCol = dayCols[0];
      } else if (dayCols.length > 1) {
        const dayMidX = (dayLeft + dayRight) / 2;
        matchedCol = cellCenterX <= dayMidX ? dayCols[0] : dayCols[dayCols.length - 1];
      }
    }

    const role = matchedCol ? matchedCol.role : (cellCenterX < (matchedDay.left + matchedDay.right)/2 ? 'staff' : 'student');

    const startIdx = topToSlotIndex(cell.top);
    const endIdx = bottomToSlotIndex(cell.bottom);
    const startTime = TIME_SLOTS[startIdx];
    const endTime = endIdx < 7 ? TIME_SLOTS[endIdx + 1] : null;

    console.log(`  "${cell.text.padEnd(22)}" day=${matchedDay.dayName.padEnd(10)} role=${role.padEnd(8)} top=${String(cell.top).padStart(3)} h=${String(cell.height).padStart(3)} slots=${startIdx}-${endIdx} (${startTime})`);

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
      const key = s.titleSpans.join('|').slice(0,80) + '|' + s.namedCells.slice(0,3).map(c=>c.text).join('|');
      if (!seen.has(key) && s.namedCells.length > 0) {
        seen.add(key);
        allSlides.push(s);
        console.log(`Captured: "${s.titleSpans.slice(0,2).join(' ').slice(0,60)}" | days=[${s.dayHeaders.map(d=>d.dayName).join(',')}] | cols=${s.colHeaders.length} | cells=${s.namedCells.length}`);
        // Debug: show first 10 cell texts to understand structure
        console.log(`  First cell texts: ${s.allCellTexts.slice(0,10).join(' | ')}`);
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

  console.log(`\nTotal slides captured: ${allSlides.length}`);

  const schedules = allSlides.map((s, i) => {
    console.log(`\n--- Slide ${i+1}: ${s.titleSpans.slice(0,1).join(' ').slice(0,50)} ---`);
    return parseSlideGeometry(s);
  }).filter(Boolean);

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
    DAY_NAMES.forEach(day => {
      const d = s.schedule[day];
      if (!d) return;
      const students = (d.studentShifts||[]).map(sh=>`${sh.name} ${sh.startTime}${sh.endTime?' until '+sh.endTime:'+'}`).join(', ')||'none';
      lines.push(`  ${day} (${d.date}): Staff=${d.staff||'TBD'} | Students=${students}`);
    });
    return lines.join('\n');
  }).join('\n\n');

  console.log('\n=== SUMMARY ===\n' + summary);

  // Always write valid schedule.json even if empty
  const output = {
    lastUpdated: new Date().toISOString(),
    source: CANVA_URL,
    totalWeeks: unique.length,
    schedules: unique,
    summary
  };

  fs.writeFileSync('schedule.json', JSON.stringify(output, null, 2));
  console.log('\nschedule.json written.');
  await browser.close();
})();
