const fs = require('fs');

const CANVA_URL = 'https://www.canva.com/design/DAHHhHnjj2M/oEPQa0XCe7iMRugy6ttYrg/view';
const TEAM_CODES = ['OPS','URP','PHA','NSF','EXP','CPD'];

const TIME_ORDER = [
  '9AM - 10AM','10AM - 11AM','11AM - 12PM',
  '12PM - 1PM','1PM - 2PM','2PM - 3PM',
  '3PM - 4PM','4PM - 5PM'
];

const TIME_TO_24 = {
  '9AM - 10AM':'09:00','10AM - 11AM':'10:00','11AM - 12PM':'11:00',
  '12PM - 1PM':'12:00','1PM - 2PM':'13:00','2PM - 3PM':'14:00',
  '3PM - 4PM':'15:00','4PM - 5PM':'16:00'
};

function parseMonthDay(str) {
  if (!str) return null;
  const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const m = str.trim().match(/([a-z]+)\s+(\d+)/i);
  if (!m) return null;
  const mon = months[m[1].toLowerCase().slice(0,3)];
  if (mon === undefined) return null;
  return { month: mon, day: parseInt(m[2]) };
}

function calLink(title, dateStr, start24, end24) {
  const parsed = parseMonthDay(dateStr);
  if (!parsed) return '#';
  const pad = n => String(n).padStart(2,'0');
  const y = 2026;
  const startDt = `${y}-${pad(parsed.month+1)}-${pad(parsed.day)}T${start24}:00`;
  const endDt   = `${y}-${pad(parsed.month+1)}-${pad(parsed.day)}T${end24}:00`;
  const p = new URLSearchParams({ subject: title, startdt: startDt, enddt: endDt, allday: 'false', showas: 'free' });
  return `https://outlook.cloud.microsoft.com/calendar/0/action/compose?${p.toString()}`;
}

function fmt12(t24) {
  const [h] = t24.split(':').map(Number);
  return h >= 12 ? `${h === 12 ? 12 : h-12}PM` : `${h === 0 ? 12 : h}AM`;
}

function isTeamCode(name) {
  return TEAM_CODES.includes((name||'').trim().toUpperCase());
}

function isHoliday(name) {
  return (name||'').toLowerCase().includes('closed') || (name||'').toLowerCase().includes('holiday');
}

function isNote(name) {
  return (name||'').toLowerCase().includes('observed') || 
         (name||'').toLowerCase().includes('independence') ||
         (name||'').toLowerCase().includes('juneteenth') ||
         (name||'').toLowerCase().includes('memorial');
}

function getNextWeek(schedules) {
  const today = new Date();
  const seen = new Set();
  const unique = schedules.filter(s => {
    if (!s.week) return false;
    const key = s.week.toLowerCase().replace(/\s+/g,'');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const s of unique) {
    const mon = s.schedule['Monday'];
    if (!mon?.date) continue;
    const parsed = parseMonthDay(mon.date);
    if (!parsed) continue;
    const weekEnd = new Date(2026, parsed.month, parsed.day + 6);
    if (weekEnd >= today) return { nextWeek: s, allWeeks: unique };
  }
  return { nextWeek: unique[0], allWeeks: unique };
}

function renderDay(dayName, data) {
  const date = (data.date || '').toUpperCase();
  const lines = [];

  lines.push(`<div class="day">`);
  lines.push(`<div class="day-hdr">${dayName.toUpperCase()}${date ? ', ' + date : ''}</div>`);

  const staff = data.staff || null;

  if (isHoliday(staff)) {
    lines.push(`<div class="row holiday">🏛️ ${staff}</div>`);
  } else {
    // Staff row
    if (!staff) {
      lines.push(`<div class="row"><span class="lbl">Staff</span><span class="empty">No staff assigned</span></div>`);
    } else if (isTeamCode(staff)) {
      lines.push(`<div class="row"><span class="lbl">Staff</span><span class="team">${staff}</span></div>`);
    } else {
      const link = calLink(`Front Desk (All Day): ${staff}`, data.date, '09:00', '17:00');
      lines.push(`<div class="row"><span class="lbl">Staff</span><a href="${link}" class="name">${staff}<span class="badge">+ Calendar</span></a></div>`);
    }

    // Figure out morning gap (9AM–1PM) and afternoon gap (1PM–5PM)
    const shifts = data.studentShifts || [];
    const hasMorning = shifts.some(s => TIME_TO_24[s.startTime] < '13:00');
    const hasAfternoon = shifts.some(s => TIME_TO_24[s.startTime] >= '13:00');

    if (shifts.length === 0) {
      lines.push(`<div class="row"><span class="lbl">Student Staff</span><span class="empty">No student staff assigned</span></div>`);
    } else {
      // Show morning gap if afternoon shift exists but no morning shift
      if (!hasMorning && hasAfternoon) {
        lines.push(`<div class="row"><span class="lbl">Student Staff</span><span class="empty">No student staff 9AM–1PM</span></div>`);
      }

      shifts.forEach(shift => {
        const name = shift.name || '';
        const start = TIME_TO_24[shift.startTime] || '09:00';
        const end = shift.endTime ? (TIME_TO_24[shift.endTime] || '17:00') : '17:00';
        const timeLabel = `${fmt12(start)}–${fmt12(end)}`;

        if (isNote(name)) {
          lines.push(`<div class="row"><span class="lbl">Student Staff</span><span class="note">📌 ${name}</span></div>`);
        } else if (isTeamCode(name)) {
          lines.push(`<div class="row"><span class="lbl">Student Staff</span><span class="team">${name} · ${timeLabel}</span></div>`);
        } else {
          const link = calLink(`Front Desk ${timeLabel}: ${name}`, data.date, start, end);
          lines.push(`<div class="row"><span class="lbl">Student Staff</span><a href="${link}" class="name">${name} · ${timeLabel}<span class="badge">+ Calendar</span></a></div>`);
        }
      });
    }
  }

  lines.push(`</div>`);
  return lines.join('\n');
}

function renderUpcoming(weeks, skipWeek) {
  const DAY_ABBR = ['Mon','Tue','Wed','Thu','Fri'];
  const DAY_KEYS = ['Monday','Tuesday','Wednesday','Thursday','Friday'];

  const rows = weeks
    .filter(w => w.week !== skipWeek.week)
    .slice(0, 8)
    .map(w => {
      const staffCells = DAY_KEYS.map((d, i) => {
        const s = w.schedule[d]?.staff;
        if (!s) return `<span class="na">—</span>`;
        if (isHoliday(s)) return `<span class="hol">Holiday</span>`;
        return `${s}<br><span class="day-tag">${DAY_ABBR[i]}</span>`;
      });

      const studentNames = [...new Set(
        DAY_KEYS.flatMap(d =>
          (w.schedule[d]?.studentShifts || [])
            .map(s => s.name)
            .filter(n => n && !isNote(n))
        )
      )];

      return `<tr>
        <td class="wk-col">${w.week}</td>
        ${staffCells.map(c => `<td>${c}</td>`).join('')}
        <td>${studentNames.join('<br>') || '<span class="na">—</span>'}</td>
      </tr>`;
    }).join('\n');

  return `<table class="tbl">
  <thead><tr>
    <th>Week</th><th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th><th>Student Staff</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function generate(scheduleData) {
  const { nextWeek, allWeeks } = getNextWeek(scheduleData.schedules);
  const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday'];

  const spotlightDays = DAYS.map(d =>
    renderDay(d, nextWeek.schedule[d] || {})
  ).join('\n');

  const upcomingTable = renderUpcoming(allWeeks, nextWeek);
  const updated = new Date(scheduleData.lastUpdated).toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body{font-family:Arial,sans-serif;max-width:700px;margin:0 auto;padding:16px;color:#1a1a1a;font-size:14px;}
  .hdr{background:#1a1a2e;color:#fff;padding:18px 20px;border-radius:8px;margin-bottom:16px;}
  .hdr h1{margin:0 0 4px;font-size:19px;font-weight:600;}
  .hdr p{margin:0;opacity:0.75;font-size:13px;}
  .tip{background:#fff8e1;border-left:4px solid #f9a825;padding:9px 14px;font-size:13px;margin-bottom:18px;border-radius:0 6px 6px 0;}
  .day{margin-bottom:12px;border:1px solid #e0e0e0;border-radius:7px;overflow:hidden;}
  .day-hdr{background:#e8eaf6;padding:8px 14px;font-weight:700;font-size:12px;letter-spacing:.06em;color:#283593;}
  .row{padding:7px 14px;border-top:1px solid #f0f0f0;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;}
  .lbl{color:#888;font-size:11px;min-width:88px;flex-shrink:0;text-transform:uppercase;letter-spacing:.04em;}
  .name{color:#1565c0;text-decoration:none;font-weight:500;}
  .name:hover{text-decoration:underline;}
  .badge{background:#e3f2fd;color:#1565c0;font-size:10px;padding:1px 7px;border-radius:10px;margin-left:8px;font-weight:400;white-space:nowrap;}
  .empty{color:#bbb;font-style:italic;}
  .team{color:#6a1b9a;font-weight:500;}
  .note{color:#e65100;}
  .holiday{color:#c62828;font-style:italic;padding:8px 14px;}
  .hol{color:#c62828;font-size:12px;}
  .na{color:#ccc;}
  .sec{font-size:15px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:2px solid #e8eaf6;color:#283593;}
  .tbl{width:100%;border-collapse:collapse;font-size:12px;}
  .tbl th{background:#e8eaf6;padding:7px 8px;text-align:left;color:#283593;font-weight:600;border-bottom:2px solid #c5cae9;}
  .tbl td{padding:7px 8px;border-bottom:1px solid #f0f0f0;vertical-align:top;line-height:1.5;}
  .tbl tr:hover td{background:#fafafa;}
  .wk-col{font-weight:600;white-space:nowrap;color:#444;}
  .day-tag{color:#aaa;font-size:10px;}
  .canva{margin-top:20px;padding:12px 16px;background:#f3e5f5;border-radius:7px;font-size:13px;}
  .canva a{color:#6a1b9a;font-weight:600;}
  .footer{margin-top:20px;font-size:11px;color:#aaa;border-top:1px solid #f0f0f0;padding-top:12px;}
</style>
</head><body>

<div class="hdr">
  <h1>📋 Pathways Center Front Desk Schedule</h1>
  <p>Week of ${nextWeek.week}</p>
</div>

<div class="tip">👆 Click any name to add that shift to your Outlook calendar — it will appear as <strong>free</strong> so it won't block your availability.</div>

${spotlightDays}

<div class="sec">Upcoming Weeks</div>
${upcomingTable}

<div class="canva">
  🎨 Need to make a change? <a href="${CANVA_URL}">Open the schedule in Canva →</a>
</div>

<div class="footer">
  Sent automatically every Friday. Schedule last updated: ${updated}.
</div>

</body></html>`;
}

// Read schedule.json, generate email-body.html
const data = JSON.parse(fs.readFileSync('schedule.json', 'utf8'));
const html = generate(data);
fs.writeFileSync('email-body.html', html);
console.log('email-body.html written successfully.');
