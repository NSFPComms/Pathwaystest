const { chromium } = require('playwright');
const fs = require('fs');

const CANVA_URL = 'https://www.canva.com/design/DAHHhHnjj2M/oEPQa0XCe7iMRugy6ttYrg/view';

const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
const DAY_PATTERNS = [/monday/i,/tuesday/i,/wednesday/i,/thursday/i,/friday/i];

function isTimeSlot(t) {
  return /^\d+\s*(AM|PM)\s*-\s*\d+\s*(AM|PM)$/i.test(t.trim());
}

function cleanName(raw) {
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

function isSkip(token) {
  const t = token.toLowerCase().replace(/\s+/g, '');
  if (['staff','studentstaff','2ndfloor'].includes(t)) return true;
  if (DAY_PATTERNS.some(p => p.test(token))) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\d+/i.test(token.trim())) return true;
  if (/^\(.*\)$/.test(token.trim())) return true;
  return false;
}

function isName(token) {
  const t = token.trim();
  if (!t || t.length < 2) return false;
  if (isTimeSlot(t)) return false;
  if (isSkip(t)) return false;
  return /[a-zA-Z]{2,}/.test(t);
}

function extractWeekTitle(titleSpans) {
  const joined = titleSpans.join(' ');
  const m = joined.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d+)\s*[-–]\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d+,?\s*\d{4})/i);
  if (m) return m[0].trim();
  return null;
}

function parseBlock(rawText, titleSpans) {
  const tokens = rawText.split('|').map(t => t.trim()).filter(Boolean);

  const days = [];
  tokens.forEach((tok, i) => {
    DAY_NAMES.forEach((day, di) => {
      if (DAY_PATTERNS[di].test(tok) && !days.find(d => d.name === day)) {
        const combined = tok + ' ' + (tokens[i+1] || '');
        const dateM = combined.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d+)/i);
        days.push({ name: day, date: dateM ? dateM[1].replace(/\s+/,' ').trim() : null });
      }
    });
  });
  if (!days.length) return null;

  const colTypes = [];
  days.forEach(() => { colTypes.push('staff'); colTypes.push('student'); });
  const NUM_COLS = colTypes.length;

  const firstTimeIdx = tokens.findIndex(t => isTimeSlot(t));
  if (firstTimeIdx === -1) return null;

  const timeGroups = [];
  let cur = null;
  tokens.slice(firstTimeIdx).forEach(tok => {
    if (isTimeSlot(tok)) {
      cur = { time: tok.trim(), names: [] };
      timeGroups.push(cur);
    } else if (isName(tok) && cur) {
      cur.names.push(cleanName(tok));
    }
  });

  const colAssignment = new Array(NUM_COLS).fill(null);
  const finalShifts = [];

  timeGroups.forEach((group) => {
    let nameIdx = 0;
    for (let col = 0; col < NUM_COLS && nameIdx < group.names.length; col++) {
      if (!colAssignment[col]) {
        colAssignment[col] = { name: group.names[nameIdx], startTime: group.time };
        nameIdx++;
      }
    }
    for (let col = 0; col < NUM_COLS && nameIdx < group.names.length; col++) {
      if (colAssignment[col] && colTypes[col] === 'student') {
        finalShifts.push({ col, ...colAssignment[col], endTime: group.time });
        colAssignment[col] = { name: group.names[nameIdx], startTime: group.time };
        nameIdx++;
      }
    }
  });

  for (let col = 0; col < NUM_COLS; col++) {
    if (colAssignment[col]) {
      finalShifts.push({ col, ...colAssignment[col], endTime: null });
    }
  }

  const schedule = {};
  days.forEach(d => { schedule[d.name] = { date: d.date, staff: null, studentShifts: [] }; });

  finalShifts.forEach(shift => {
    const dayIdx = Math.floor(shift.col / 2);
    const day = days[dayIdx];
    if (!day) return;
    if (colTypes[shift.col] === 'staff') {
      schedule[day.name].staff = shift.name;
    } else {
      schedule[day.name].studentShifts.push({
        startTime: shift.startTime,
        endTime: shift.endTime,
        name: shift.name
      });
    }
  });

  return { week: extractWeekTitle(titleSpans), schedule };
}

function extractFromDOM(pane) {
  const titleSpans = Array.from(pane.querySelectorAll('p._28USrA span.a_GcMg'))
    .map(s => s.innerText.trim())
    .filter(t => t.length > 1);

  const tables = pane.querySelectorAll('table');
  const results = [];

  tables.forEach(table => {
    const rows = Array.from(table.querySelectorAll('tr'));
    const tableData = [];
    rows.forEach(row => {
      const cells = Array.from(row.querySelectorAll('td'));
      if (!cells.length) return;
      const rowData = cells.map(c => c.innerText.replace(/\s+/g,' ').trim()).filter(t => t.length);
      if (rowData.length) tableData.push(rowData);
    });
    if (tableData.length) {
      results.push({ titleSpans, rawText: tableData.map(r => r.join(' | ')).join(' | ') });
    }
  });

  return results;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('Navigating to Canva...');
  await page.goto(CANVA_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('table', { timeout: 30000 });
  await page.waitForTimeout(2000);

  // Get total page count from the "1 / 15" indicator
  const totalPages = await page.evaluate(() => {
    const counter = document.querySelector('[aria-valuemax]');
    return counter ? parseInt(counter.getAttribute('aria-valuemax')) : null;
  });
  console.log(`Total slides: ${totalPages || 'unknown'}`);

  const allRaw = [];
  const seen = new Set();

  async function collectCurrentSlide() {
    await page.waitForTimeout(1500); // let slide render
    const raw = await page.evaluate(extractFromDOM.toString() + `
      ;const panes = document.querySelectorAll('._mXnjA[aria-hidden="false"], ._mXnjA:not([aria-hidden])');
      const results = [];
      panes.forEach(p => extractFromDOM(p).forEach(r => results.push(r)));
      return results;
    `);
    raw.forEach(r => {
      const key = r.rawText.slice(0, 100);
      if (!seen.has(key) && r.rawText.includes('AM') && r.rawText.includes('PM')) {
        seen.add(key);
        allRaw.push(r);
        console.log(`  Captured: ${r.titleSpans.slice(0,2).join(' ')}`);
      }
    });
  }

  // Collect first slide
  await collectCurrentSlide();

  // Click through all remaining slides
  const pages = totalPages || 20;
  for (let i = 1; i < pages; i++) {
    const nextBtn = await page.$('[aria-label="Next page"]');
    if (!nextBtn) break;
    const disabled = await nextBtn.getAttribute('aria-disabled');
    if (disabled === 'true') break;
    await nextBtn.click();
    await collectCurrentSlide();
  }

  console.log(`\nTotal unique schedule tables found: ${allRaw.length}`);

  const schedules = allRaw.map(r => parseBlock(r.rawText, r.titleSpans)).filter(Boolean);

  // Build summary
  const summary = schedules.map(s => {
    if (!s.week) return null;
    const lines = [`Week of ${s.week}:`];
    Object.entries(s.schedule).forEach(([day, data]) => {
      lines.push(`  ${day}${data.date ? ' ('+data.date+')' : ''}:`);
      lines.push(`    Staff: ${data.staff || 'TBD'}`);
      if (data.studentShifts.length) {
        data.studentShifts.forEach(sh => {
          const end = sh.endTime ? ` until ${sh.endTime}` : '+';
          lines.push(`    Student staff: ${sh.name} (${sh.startTime}${end})`);
        });
      } else {
        lines.push(`    Student staff: TBD`);
      }
    });
    return lines.join('\n');
  }).filter(Boolean).join('\n\n');

  const output = {
    lastUpdated: new Date().toISOString(),
    source: CANVA_URL,
    totalWeeks: schedules.length,
    schedules,
    summary
  };

  fs.writeFileSync('schedule.json', JSON.stringify(output, null, 2));
  console.log('\nschedule.json written.');
  console.log('\n' + summary);
  await browser.close();
})();
