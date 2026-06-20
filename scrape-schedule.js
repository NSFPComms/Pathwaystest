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
  return 'Unknown week';
}

function parseBlock(rawText, titleSpans) {
  const tokens = rawText.split('|').map(t => t.trim()).filter(Boolean);

  // Find days
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

  // Column types: staff, student alternating per day
  const colTypes = [];
  days.forEach(() => { colTypes.push('staff'); colTypes.push('student'); });
  const NUM_COLS = colTypes.length;

  // Find first time slot
  const firstTimeIdx = tokens.findIndex(t => isTimeSlot(t));
  if (firstTimeIdx === -1) return null;

  // Parse time groups
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

  // Assign names to columns across time
  const colAssignment = new Array(NUM_COLS).fill(null);
  const finalShifts = [];

  timeGroups.forEach((group) => {
    let nameIdx = 0;
    // Fill empty columns first
    for (let col = 0; col < NUM_COLS && nameIdx < group.names.length; col++) {
      if (!colAssignment[col]) {
        colAssignment[col] = { name: group.names[nameIdx], startTime: group.time };
        nameIdx++;
      }
    }
    // Remaining names replace existing student columns (new shift starting)
    for (let col = 0; col < NUM_COLS && nameIdx < group.names.length; col++) {
      if (colAssignment[col] && colTypes[col] === 'student') {
        finalShifts.push({ col, ...colAssignment[col], endTime: group.time });
        colAssignment[col] = { name: group.names[nameIdx], startTime: group.time };
        nameIdx++;
      }
    }
  });

  // Close remaining open assignments
  for (let col = 0; col < NUM_COLS; col++) {
    if (colAssignment[col]) {
      finalShifts.push({ col, ...colAssignment[col], endTime: null });
    }
  }

  // Build schedule
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

  return {
    week: extractWeekTitle(titleSpans),
    schedule
  };
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('Navigating to Canva...');
  await page.goto(CANVA_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('table', { timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log('Page loaded. Extracting...');

  const raw = await page.evaluate(() => {
    const results = [];

    // Get all Canva slide pages
    const slidePanes = document.querySelectorAll('._mXnjA');

    slidePanes.forEach(pane => {
      // Title spans for this slide
      const titleSpans = Array.from(pane.querySelectorAll('p._28USrA span.a_GcMg'))
        .map(s => s.innerText.trim())
        .filter(t => t.length > 1);

      // Tables in this slide
      const tables = pane.querySelectorAll('table');
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
          results.push({
            titleSpans,
            rawText: tableData.map(r => r.join(' | ')).join(' | ')
          });
        }
      });
    });

    return results;
  });

  console.log(`Found ${raw.length} table(s) across slides.`);

  // Deduplicate (Canva renders each slide twice — visible + aria-hidden)
  const seen = new Set();
  const unique = raw.filter(r => {
    const key = r.rawText.slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const schedules = unique.map(r => parseBlock(r.rawText, r.titleSpans)).filter(Boolean);

  // Build human-readable summary
  const summary = schedules.map(s => {
    const lines = [`Week of ${s.week}:`];
    Object.entries(s.schedule).forEach(([day, data]) => {
      lines.push(`  ${day} ${data.date ? '('+data.date+')' : ''}:`);
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
  }).join('\n\n');

  const output = {
    lastUpdated: new Date().toISOString(),
    source: CANVA_URL,
    schedules,
    summary
  };

  fs.writeFileSync('schedule.json', JSON.stringify(output, null, 2));
  console.log('schedule.json written.\n');
  console.log(summary);
  await browser.close();
})();
