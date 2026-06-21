const { chromium } = require('playwright');
const fs = require('fs');

const CANVA_URL = 'https://www.canva.com/design/DAHHhHnjj2M/oEPQa0XCe7iMRugy6ttYrg/view';

// Known staff members — any name matching one of these is STAFF, not student staff
// Stored as lowercase for fuzzy matching
const KNOWN_STAFF = [
  'xu jiahong','li lina','garber andrew','grimmett branden','quach alex','wang rita',
  'bangura amelia','march frank','brown tabitha','boyd michael','owens kendra',
  'holst abby','oh tiffany','araya nydia','araya-stivers nydia','cox beverly',
  'wrenn rapp diana','wrenn diana','diana wrenn','fisher natima','hollinger gregory',
  'still anthony','mckelvy mick','almeida carmen','bazile tim','caraballo luz',
  'magnanini luca','amanuel leah','harris katelyn','murat renoal','murat rey','rey murat',
  'melton sheryl','dsouza natasha','friddle megan','laupert danielle','goode edmund',
  'goode ed','ed goode','herold tricia','pak susan','chau kelly','cornwell don',
  'don cornwell','riddock carol','carol riddock','waller asia','mccrary jessie',
  'jessie mc crary','jessie mccrary','long amanda','tucker micah','micah tucker',
  'bakhit naadia','murray jack','aguilera sandra','anderson steven','jahn tristen',
  'tristen jahn','molee kim','hansen bridget','bridget hansen','gunnels bridgette',
  'debarati roy','roy debarati','sapna david','david sapna','diana wrenn rapp',
  'tim bazile','amanda long','abby holst','tiffany oh','natima fisher','kendra owens',
  'michael boyd','alex quach','katelyn harris','megan friddle','carol riddock',
  'amelia bangura','tricia herold','ed goode','don cornwell','micah tucker',
  'kelshay toomer','toomer kelshay','rey murat','renoal murat','sandra aguilera',
  'beth white','white beth','nydia araya','marshall tucker','tucker marshall',
  'aj scott','scott aj','bridget hansen','jessie mc crary','kendra owens',
  'kelshay toomer','pha staff','ops staff'
].map(n => n.toLowerCase());

const TEAM_CODES = ['OPS','URP','PHA','NSF','EXP','CPD'];
const DAY_NAMES = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
const DAY_PATTERNS = [/monday/i,/tuesday/i,/wednesday/i,/thursday/i,/friday/i];

const TIME_TO_ORDER = {
  '9AM - 10AM':0,'10AM - 11AM':1,'11AM - 12PM':2,
  '12PM - 1PM':3,'1PM - 2PM':4,'2PM - 3PM':5,
  '3PM - 4PM':6,'4PM - 5PM':7
};

function isTimeSlot(t) {
  return /^\d+\s*(AM|PM)\s*-\s*\d+\s*(AM|PM)$/i.test((t||'').trim());
}

function cleanName(raw) {
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
}

function isKnownStaff(name) {
  if (!name) return false;
  const n = name.toLowerCase().replace(/\s+/g,' ').trim();
  return KNOWN_STAFF.some(s => n.includes(s) || s.includes(n));
}

function isTeamCode(name) {
  return TEAM_CODES.includes((name||'').trim().toUpperCase());
}

function isHoliday(name) {
  const n = (name||'').toLowerCase();
  return n.includes('closed') || n.includes('memorial day') ||
         n.includes('juneteenth') || n.includes('independence day') ||
         n.includes('university closed');
}

function isSkipToken(token) {
  const t = (token||'').toLowerCase().replace(/\s+/g,'');
  if (['2ndfloor','floor','staff','studentstaff'].includes(t)) return true;
  if (DAY_PATTERNS.some(p => p.test(token))) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\d+/i.test((token||'').trim())) return true;
  if (/^\(.*\)$/.test((token||'').trim())) return true;
  return false;
}

function isName(token) {
  const t = (token||'').trim();
  if (!t || t.length < 2) return false;
  if (isTimeSlot(t)) return false;
  if (isSkipToken(t)) return false;
  return /[a-zA-Z]{2,}/.test(t);
}

function extractWeekTitle(titleSpans) {
  const joined = titleSpans.join(' ');
  const m = joined.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d+)\s*[-–]\s*((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d+,?\s*\d{4})/i);
  if (m) return m[0].trim();
  return null;
}

function parseBlock(tableRows, titleSpans) {
  if (!tableRows || tableRows.length < 3) return null;

  // Find day header row and sub-header row
  let dayHeaderRowIdx = -1;
  let subHeaderRowIdx = -1;

  for (let i = 0; i < Math.min(tableRows.length, 5); i++) {
    const row = tableRows[i];
    const hasDays = row.some(c => DAY_PATTERNS.some(p => p.test(c)));
    const hasSubHeaders = row.some(c => {
      const t = (c||'').toLowerCase().replace(/\s+/g,'');
      return t === 'staff' || t === 'studentstaff';
    });
    if (hasDays && dayHeaderRowIdx === -1) dayHeaderRowIdx = i;
    if (hasSubHeaders && subHeaderRowIdx === -1) subHeaderRowIdx = i;
  }

  if (subHeaderRowIdx === -1 || dayHeaderRowIdx === -1) return null;

  // Extract days from day header row
  const days = [];
  tableRows[dayHeaderRowIdx].forEach(cell => {
    DAY_NAMES.forEach((day, di) => {
      if (DAY_PATTERNS[di].test(cell) && !days.find(d => d.name === day)) {
        const dateM = cell.match(/((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*\d+)/i);
        days.push({ name: day, date: dateM ? dateM[1].replace(/\s+/,' ').trim() : null });
      }
    });
  });

  if (!days.length) return null;

  // Build column map from sub-header row
  // Each cell is 'staff', 'student', or skip (the '2ND FLOOR' label cell)
  const subRow = tableRows[subHeaderRowIdx];
  const colMap = []; // {dayName, date, role}
  let dayIdx = 0;
  let staffCountForDay = 0;

  subRow.forEach(cell => {
    const t = (cell||'').toLowerCase().replace(/\s+/g,'');
    if (t === 'staff') {
      if (days[dayIdx]) {
        colMap.push({ dayName: days[dayIdx].name, date: days[dayIdx].date, role: 'staff' });
        staffCountForDay++;
      }
    } else if (t === 'studentstaff') {
      if (days[dayIdx]) {
        colMap.push({ dayName: days[dayIdx].name, date: days[dayIdx].date, role: 'student' });
        // After student staff col, move to next day
        dayIdx++;
        staffCountForDay = 0;
      }
    }
  });

  if (!colMap.length) return null;

  // Parse data rows — track current value per column (empty cell = rowspan, keep previous)
  const dataRows = tableRows.slice(subHeaderRowIdx + 1);
  const colCurrent = new Array(colMap.length).fill(null);
  const colStartTime = new Array(colMap.length).fill(null);
  const completedShifts = [];
  let currentTime = null;

  dataRows.forEach(row => {
    // First cell may be a time slot label or empty
    let dataStartIdx = 0;
    if (isTimeSlot(row[0])) {
      currentTime = row[0].trim();
      dataStartIdx = 1;
    } else if (!row[0] || row[0].trim() === '') {
      dataStartIdx = 1;
    } else {
      // First cell might be a time in some rows
      dataStartIdx = 1;
    }

    if (!currentTime) return;

    const dataCells = row.slice(dataStartIdx);

    for (let col = 0; col < colMap.length; col++) {
      const cell = (dataCells[col] || '').trim();

      if (cell && isName(cell)) {
        const name = cleanName(cell);
        // End previous occupant
        if (colCurrent[col] && colCurrent[col] !== name) {
          completedShifts.push({
            ...colMap[col],
            name: colCurrent[col],
            startTime: colStartTime[col],
            endTime: currentTime
          });
          colCurrent[col] = name;
          colStartTime[col] = currentTime;
        } else if (!colCurrent[col]) {
          colCurrent[col] = name;
          colStartTime[col] = currentTime;
        }
        // If same name continues, do nothing (rowspan)
      }
      // Empty cell = previous value continues
    }
  });

  // Close remaining
  for (let col = 0; col < colMap.length; col++) {
    if (colCurrent[col]) {
      completedShifts.push({
        ...colMap[col],
        name: colCurrent[col],
        startTime: colStartTime[col],
        endTime: null
      });
    }
  }

  // Build schedule — use known staff list to correct any misassignments
  const schedule = {};
  days.forEach(d => { schedule[d.name] = { date: d.date, staff: null, studentShifts: [] }; });

  completedShifts.forEach(shift => {
    if (!schedule[shift.dayName]) return;
    const name = shift.name;

    // Override role based on known staff list
    let role = shift.role;
    if (isHoliday(name)) {
      // Holidays go on the staff line for display
      role = 'staff';
    } else if (isKnownStaff(name) || isTeamCode(name)) {
      role = 'staff';
    } else {
      role = 'student';
    }

    if (role === 'staff') {
      // Only set staff if not already set, or override if this is a better match
      if (!schedule[shift.dayName].staff) {
        schedule[shift.dayName].staff = name;
      }
    } else {
      // Avoid duplicate student shifts
      const alreadyAdded = schedule[shift.dayName].studentShifts
        .some(s => s.name === name && s.startTime === shift.startTime);
      if (!alreadyAdded) {
        schedule[shift.dayName].studentShifts.push({
          startTime: shift.startTime,
          endTime: shift.endTime,
          name: name
        });
      }
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
        .map(s => s.innerText.trim()).filter(t => t.length > 1);
      const tables = pane.querySelectorAll('table');
      tables.forEach(table => {
        const rows = Array.from(table.querySelectorAll('tr'));
        const tableRows = [];
        rows.forEach(row => {
          const cells = Array.from(row.querySelectorAll('td'));
          if (!cells.length) return;
          tableRows.push(cells.map(c => c.innerText.replace(/\s+/g,' ').trim()));
        });
        if (tableRows.length > 2) results.push({ titleSpans, tableRows });
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
      const key = r.tableRows.slice(0,3).map(row => row.join('|')).join('||').slice(0,120);
      if (!seen.has(key)) {
        seen.add(key);
        allRaw.push(r);
        console.log(`  Captured: ${r.titleSpans.slice(0,2).join(' ') || '(no title)'}`);
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

  console.log(`\nTotal unique tables: ${allRaw.length}`);
  const schedules = allRaw.map(r => parseBlock(r.tableRows, r.titleSpans)).filter(Boolean);

  const summary = schedules.filter(s => s.week).map(s => {
    const lines = [`Week of ${s.week}:`];
    ['Monday','Tuesday','Wednesday','Thursday','Friday'].forEach(day => {
      const d = s.schedule[day];
      if (!d) return;
      lines.push(`  ${day} (${d.date}): Staff=${d.staff||'TBD'} | Students=${(d.studentShifts||[]).map(sh=>`${sh.name} ${sh.startTime}`).join(', ')||'none'}`);
    });
    return lines.join('\n');
  }).join('\n\n');

  const output = { lastUpdated: new Date().toISOString(), source: CANVA_URL, totalWeeks: schedules.length, schedules, summary };
  fs.writeFileSync('schedule.json', JSON.stringify(output, null, 2));
  console.log('\nschedule.json written.\n');
  console.log(summary);
  await browser.close();
})();
