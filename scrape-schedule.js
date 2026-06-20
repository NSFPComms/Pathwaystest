const { chromium } = require('playwright');
const fs = require('fs');

const CANVA_URL = 'https://www.canva.com/design/DAHHhHnjj2M/oEPQa0XCe7iMRugy6ttYrg/view';

function extractText(el) {
  return el.innerText?.replace(/\s+/g, ' ').trim() || '';
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  console.log('Navigating to Canva...');
  await page.goto(CANVA_URL, { waitUntil: 'networkidle', timeout: 60000 });

  // Wait for the table to render
  await page.waitForSelector('table', { timeout: 30000 });
  // Extra buffer for all cells to populate
  await page.waitForTimeout(3000);

  console.log('Page loaded. Extracting schedule data...');

  const result = await page.evaluate(() => {
    const pages = [];

    // Each "page" in the Canva doc is a separate slide/section
    // The table is the schedule grid — find all tables on the page
    const tables = document.querySelectorAll('table');

    tables.forEach((table, tableIndex) => {
      // Extract header: look for title text above the table
      // Canva puts the title in a span with class a_GcMg before the table
      const allSpans = Array.from(document.querySelectorAll('span.a_GcMg'));

      // Get all text from the table cells
      const rows = Array.from(table.querySelectorAll('tr'));
      const tableData = [];

      rows.forEach(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length === 0) return;
        const rowData = cells.map(cell => {
          return cell.innerText.replace(/\s+/g, ' ').trim();
        }).filter(t => t.length > 0);
        if (rowData.length > 0) tableData.push(rowData);
      });

      if (tableData.length > 0) {
        pages.push({ tableIndex, rows: tableData });
      }
    });

    // Also grab all visible span text for the title/week info
    const titleSpans = Array.from(document.querySelectorAll('p._28USrA span.a_GcMg'))
      .map(s => s.innerText.trim())
      .filter(t => t.length > 1);

    return { pages, titleSpans };
  });

  // Now structure the data properly
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const timeSlots = ['9AM-10AM', '10AM-11AM', '11AM-12PM', '12PM-1PM', '1PM-2PM', '2PM-3PM', '3PM-4PM', '4PM-5PM'];

  // Parse each table into a schedule object
  const schedules = result.pages.map((page, i) => {
    const rows = page.rows;

    // Find the week title from titleSpans — look for date range patterns
    const weekTitle = result.titleSpans.find(t =>
      t.match(/may|june|july|august|september|week/i)
    ) || `Week ${i + 1}`;

    // Build a structured day→time→person map from raw rows
    const schedule = {};
    days.forEach(d => schedule[d] = {});
    timeSlots.forEach(t => days.forEach(d => schedule[d][t] = null));

    // The raw table rows contain day headers and staff names
    // Extract day columns and time rows heuristically
    let dayHeaders = [];
    let currentTime = null;

    rows.forEach(row => {
      // Check if this row looks like day headers
      const isDayRow = row.some(cell =>
        /monday|tuesday|wednesday|thursday|friday/i.test(cell)
      );
      if (isDayRow) {
        dayHeaders = row.filter(cell =>
          /monday|tuesday|wednesday|thursday|friday/i.test(cell)
        ).map(cell => {
          if (/monday/i.test(cell)) return 'Monday';
          if (/tuesday/i.test(cell)) return 'Tuesday';
          if (/wednesday/i.test(cell)) return 'Wednesday';
          if (/thursday/i.test(cell)) return 'Thursday';
          if (/friday/i.test(cell)) return 'Friday';
          return cell;
        });
        return;
      }

      // Check if this row starts with a time slot
      const timeMatch = row[0]?.match(/(\d+(?:AM|PM)\s*-\s*\d+(?:AM|PM))/i);
      if (timeMatch) {
        currentTime = timeMatch[1].replace(/\s/g, '').toUpperCase();
        return;
      }

      // Otherwise it's staff data — assign to current time + day
      if (currentTime && dayHeaders.length > 0) {
        row.forEach((name, idx) => {
          const day = dayHeaders[idx];
          if (day && name && !['staff', 'student staff', 'student\nstaff'].includes(name.toLowerCase())) {
            if (!schedule[day]) schedule[day] = {};
            schedule[day][currentTime] = name;
          }
        });
      }
    });

    return {
      week: weekTitle,
      schedule
    };
  });

  // Also pull a flat people list for quick reference
  const allNames = new Set();
  result.titleSpans.forEach(s => {
    if (s.match(/^[A-Z][a-z]+ [A-Z][a-z]+$/) || s.match(/^[A-Z][a-z]+$/)) {
      allNames.add(s);
    }
  });

  const output = {
    lastUpdated: new Date().toISOString(),
    source: CANVA_URL,
    rawTitleText: result.titleSpans,
    schedules,
    // Flat text dump as fallback for Power Automate parsing
    rawText: result.pages.map(p => p.rows.flat().join(' | ')).join('\n\n')
  };

  fs.writeFileSync('schedule.json', JSON.stringify(output, null, 2));
  console.log('schedule.json written successfully.');
  console.log('Title spans found:', result.titleSpans.slice(0, 10));
  console.log('Tables found:', result.pages.length);

  await browser.close();
})();
