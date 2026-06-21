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
  if (['2ndfloor'].includes(t)) return true;
  if (DAY_PATTERNS.some(p => p.test(token))) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\d+/i.test(token.trim())) return true;
  if (/^\(.*\)$/.test(token.trim())) return true;
  return false;
}

function isColHeader(token) {
  const t = token.toLowerCase().replace(/\s+/g, '');
  return t === 'staff' || t === 'studentstaff';
}

function isStaffHeader(token) {
  const t = token.toLowerCase().replace(/\s+/g, '');
  return t === 'staff';
}

function isName(token) {
  const t = token.trim();
  if (!t || t.length < 2) return false;
  if (isTimeSlot(t)) return false;
  if (isSkip(t)) return false;
  if (isColHeader(t)) return false;
  return /[a-zA-Z]{2,}/.test(t);
}

function extractWeekTitle(titleSpans) {
  const joined = titleSpans.join(' ');
  const m = joined.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d+)\s*[-–]\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d+,?\s*\d{4})/i);
  if (m) return m[0].trim();
  return null;
}

function parseBlock(tableRows, titleSpans) {
  // tableRows: array of arrays of cell text strings, from the actual DOM table

  if (!tableRows || tableRows.length < 3) return null;

  // Row 0: day headers (Monday May 4, Tuesday May 5, etc.) with colspan
  // Row 1: sub-headers (STAFF, STUDENT STAFF, STAFF, STUDENT STAFF...)
  // Row 2+: time/data rows

  // Find the sub-header row — it's the first row that contains 'staff' or 'student staff'
  let subHeaderRowIdx = -1;
  let dayHeaderRowIdx = -1;

  for (let i = 0; i < Math.min(tableRows.length, 5); i++) {
    const row = tableRows[i];
    const hasColHeaders = row.some(c => isColHeader(c));
    const hasDayNames = row.some(c => DAY_PATTERNS.some(p => p.test(c)));
    if (hasDayNames && dayHeaderRowIdx === -1) dayHeaderRowIdx = i;
    if (hasColHeaders && subHeaderRowIdx === -1) subHeaderRowIdx = i;
  }

  if (subHeaderRowIdx === -1) return null;

  // Build column type map from sub-header row
  // Each cell is either 'staff' or 'student'
  const subHeaderRow = tableRows[subHeaderRowIdx];
  const colTypes = subHeaderRow.map(c => {
    const t = c.toLowerCase().replace(/\s+/g,'');
    if (t === 'staff') return 'staff';
    if (t === 'studentstaff') return 'student';
    return null;
  }).filter(Boolean);

  // Map columns to days: we have N col types, and they belong to days left-to-right
  // We need to know how many cols per day — look at day header row
  const dayHeaderRow = dayHeaderRowIdx >= 0 ? tableRows[dayHeaderRowIdx] : [];
  
  // Extract days and their dates from the day header row
  const days = [];
  // The first cell is usually "2ND FLOOR" label, then day entries
  dayHeaderRow.forEach((cell, i) => {
    DAY_NAMES.forEach((day, di) => {
      if (DAY_PATTERNS[di].test(cell) && !days.find(d => d.name === day)) {
        const dateM = cell.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d+)/i);
        days.push({ name: day, date: dateM ? dateM[1].replace(/\s+/,' ').trim() : null });
      }
    });
  });

  if (days.length === 0) return null;

  // Build full column map: [{dayName, role}]
  // colTypes array maps directly to day columns
  // e.g. [staff, student, staff, student, student, staff, student, staff, student, staff]
  // We assign them to days in order
  const colMap = []; // {dayName, role}
  let colIdx = 0;
  days.forEach(day => {
    // Count how many cols belong to this day
    // We don't know for sure, but we can figure it out:
    // total cols / total days = cols per day (usually 2, sometimes 1)
    const colsPerDay = Math.round(colTypes.length / days.length);
    for (let c = 0; c < colsPerDay && colIdx < colTypes.length; c++) {
      colMap.push({ dayName: day.name, date: day.date, role: colTypes[colIdx] });
      colIdx++;
    }
  });

  // Now parse data rows
  const dataRows = tableRows.slice(subHeaderRowIdx + 1);

  // Track what's currently filling each column (for rowspan simulation)
  const colCurrent = new Array(colMap.length).fill(null);
  const colStartTime = new Array(colMap.length).fill(null);
  const shifts = []; // {colIdx, dayName, date, role, name, startTime, endTime}

  let currentTime = null;

  dataRows.forEach(row => {
    // Check if this row is a time row (first cell is a time slot)
    // OR a data row
    const firstCell = row[0] || '';
    
    if (isTimeSlot(firstCell)) {
      currentTime = firstCell.trim();
      // The rest of the row cells are data for each column
      const dataCells = row.slice(1);
      let dataIdx = 0;
      
      for (let col = 0; col < colMap.length; col++) {
        const cell = dataCells[dataIdx] || '';
        dataIdx++;
        
        if (isName(cell)) {
          const name = cleanName(cell);
          // End previous occupant of this col
          if (colCurrent[col]) {
            shifts.push({
              colIdx: col,
              dayName: colMap[col].dayName,
              date: colMap[col].date,
              role: colMap[col].role,
              name: colCurrent[col],
              startTime: colStartTime[col],
              endTime: currentTime
            });
          }
          colCurrent[col] = name;
          colStartTime[col] = currentTime;
        }
        // Empty cell = previous value continues (rowspan)
      }
    } else if (row.length > 1 && isTimeSlot(row[1] || '')) {
      // Time might be in second cell if first is a label
      currentTime = row[1].trim();
    }
  });

  // Close all open columns
  for (let col = 0; col < colMap.length; col++) {
    if (colCurrent[col]) {
      shifts.push({
        colIdx: col,
        dayName: colMap[col].dayName,
        date: colMap[col].date,
        role: colMap[col].role,
        name: colCurrent[col],
        startTime: colStartTime[col],
        endTime: null
      });
    }
  }

  // Build schedule object
  const schedule = {};
  days.forEach(d => {
    schedule[d.name] = { date: d.date, staff: null, studentShifts: [] };
  });

  shifts.forEach(shift => {
    if (!schedule[shift.dayName]) return;
    if (shift.role === 'staff') {
      schedule[shift.dayName].staff = shift.name;
    } else {
      schedule[shift.dayName].studentShifts.push({
        startTime: shift.startTime,
        endTime: shift.endTime,
        name: shift.name
      });
    }
  });

  return { week: extractWeekTitle(titleSpans), schedule };
}

async function extractCurrentSlide(page) {
  return await page.evaluate(() => {
    const results = [];
    const panes = document.querySelectorAll('._mXnjA');

    panes.forEach(pane => {
      if (pane.getAttribute('aria-hidden') === 'true') return;

      const titleSpans = Array.from(pane.querySelectorAll('p._28USrA span.a_GcMg'))
        .map(s => s.innerText.trim())
        .filter(t => t.length > 1);

      const tables = pane.querySelectorAll('table');
      tables.forEach(table => {
        // Get ALL rows including header rows, preserving full structure
        const rows = Array.from(table.querySelectorAll('tr'));
        const tableRows = [];
        
        rows.forEach(row => {
          const cells = Array.from(row.querySelectorAll('td'));
          if (!cells.length) return;
          const rowData = cells.map(c => c.innerText.replace(/\s+/g, ' ').trim());
          // Include row even if some cells are empty (empty = rowspan continuation)
          tableRows.push(rowData);
        });

        if (tableRows.length > 2) {
          results.push({ titleSpans, tableRows });
        }
      });
    });

    return results;
  });
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

  const allRaw = [];
  const seen = new Set();

  async function collectSlide() {
    await page.waitForTimeout(1500);
    const raw = await extractCurrentSlide(page);
    raw.forEach(r => {
      const key = r.tableRows.slice(0,3).map(row => row.join('|')).join('||').slice(0, 120);
      if (!seen.has(key)) {
        seen.add(key);
        allRaw.push(r);
        const label = r.titleSpans.slice(0,2).join(' ') || '(no title)';
        console.log(`  Captured: ${label}`);
      }
    });
  }

  await collectSlide();

  for (let i = 1; i < totalPages; i++) {
    const nextBtn = await page.$('[aria-label="Next page"]');
    if (!nextBtn) break;
    const disabled = await nextBtn.getAttribute('aria-disabled');
    if (disabled === 'true') break;
    await nextBtn.click();
    await collectSlide();
  }

  console.log(`\nTotal unique tables: ${allRaw.length}`);

  const schedules = allRaw.map(r => parseBlock(r.tableRows, r.titleSpans)).filter(Boolean);

  const summary = schedules
    .filter(s => s.week)
    .map(s => {
      const lines = [`Week of ${s.week}:`];
      ['Monday','Tuesday','Wednesday','Thursday','Friday'].forEach(day => {
        const data = s.schedule[day];
        if (!data) return;
        lines.push(`  ${day} (${data.date}):`);
        lines.push(`    Staff: ${data.staff || 'TBD'}`);
        (data.studentShifts||[]).forEach(sh => {
          lines.push(`    Student: ${sh.name} ${sh.startTime}${sh.endTime ? ' until '+sh.endTime : '+'}`);
        });
      });
      return lines.join('\n');
    }).join('\n\n');

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
