const fs = require('fs');

const CANVA_URL = 'https://canva.link/qke4os46cuohhf3';
const TEAM_CODES = ['OPS','URP','PHA','NSF','EXP','CPD'];

// Parse times like "9AM", "1PM", "1:30PM" → "09:00", "13:00", "13:30"
function timeTo24(t) {
  if (!t) return '09:00';
  const m = t.match(/^(\d+)(?::(\d+))?(AM|PM)$/i);
  if (!m) return '09:00';
  let h = parseInt(m[1]);
  const mins = m[2] ? parseInt(m[2]) : 0;
  const ampm = m[3].toUpperCase();
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2,'0')}:${String(mins).padStart(2,'0')}`;
}

// TIME_TO_24 replaced by timeTo24() parser below
const TIME_TO_24_UNUSED = {
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

function weekStartDate(schedule) {
  const mon = schedule['Monday'];
  if (!mon?.date) return null;
  const p = parseMonthDay(mon.date);
  if (!p) return null;
  return new Date(2026, p.month, p.day);
}

function calLink(title, dateStr, start24, end24) {
  const parsed = parseMonthDay(dateStr);
  if (!parsed) return '#';
  const pad = n => String(n).padStart(2,'0');
  const startDt = `2026-${pad(parsed.month+1)}-${pad(parsed.day)}T${start24}:00`;
  const endDt   = `2026-${pad(parsed.month+1)}-${pad(parsed.day)}T${end24}:00`;
  const safeTitle = title.replace(/[–—]/g, '-');
  const p = new URLSearchParams({ subject: safeTitle, startdt: startDt, enddt: endDt, allday: 'false' });
  return `https://outlook.cloud.microsoft.com/calendar/0/action/compose?${p.toString()}`;
}

function fmt12short(t24) {
  // Returns "9AM", "1PM", "1:30PM" etc
  const [h, m] = t24.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2,'0')}${ampm}`;
}

function fmt12(t24) {
  const [h, m] = t24.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2,'0')}${ampm}`;
}

function firstLast(name) {
  // "Montana Jackson" -> "Montana J."
  const parts = (name||'').trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length-1][0]}.`;
}

function isTeamCode(name) {
  return TEAM_CODES.includes((name||'').trim().toUpperCase());
}

function isHoliday(name) {
  return (name||'').toLowerCase().includes('closed');
}

function isNote(name) {
  const n = (name||'').toLowerCase();
  return n.includes('observed') || n.includes('independence') ||
         n.includes('juneteenth') || n.includes('memorial');
}

function deduplicateWeeks(schedules) {
  const seen = new Set();
  return schedules.filter(s => {
    if (!s.week) return false;
    const key = s.week.toLowerCase().replace(/\s+/g,'');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getNextWeek(unique) {
  const today = new Date();
  const dow = today.getDay(); // 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
  // Calculate how many days until the NEXT Monday we want to show.
  // On Monday (dow=1): show THIS week's Monday (0 days ahead).
  // Every other day: show NEXT Monday.
  //   Sun=0 → next Mon is +1
  //   Tue=2 → next Mon is +6
  //   Wed=3 → next Mon is +5
  //   Thu=4 → next Mon is +4
  //   Fri=5 → next Mon is +3
  //   Sat=6 → next Mon is +2
  const daysToTargetMonday = dow === 1 ? 0 : (8 - dow) % 7;
  const targetMonday = new Date(today);
  targetMonday.setDate(today.getDate() + daysToTargetMonday);
  targetMonday.setHours(0, 0, 0, 0);
  // Find the schedule week whose Monday matches (or is closest after) targetMonday
  for (const s of unique) {
    const d = weekStartDate(s.schedule);
    if (!d) continue;
    if (d >= targetMonday) return s;
  }
  return unique[unique.length - 1];
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
    if (!staff) {
      lines.push(`<div class="row"><span class="lbl">Staff</span><span class="empty">No staff assigned</span></div>`);
    } else if (isTeamCode(staff)) {
      lines.push(`<div class="row"><span class="lbl">Staff</span><span class="team">${staff} &middot; <span class="muted">9AM-5PM</span></span></div>`);
    } else {
      const link = calLink(`Front Desk (All Day): ${staff}`, data.date, '09:00', '17:00');
      lines.push(`<div class="row"><span class="lbl">Staff</span><a href="${link}" class="name">${staff} &middot; <span class="muted">9AM-5PM</span><span class="badge">+ Calendar</span></a></div>`);
    }

    const shifts = data.studentShifts || [];
    const hasMorning = shifts.some(s => (timeTo24(s.startTime)||'09:00') < '13:00');
    const hasAfternoon = shifts.some(s => (timeTo24(s.startTime)||'09:00') >= '13:00');

    if (shifts.length === 0) {
      lines.push(`<div class="row"><span class="lbl">Student Staff</span><span class="empty">No student staff assigned</span></div>`);
    } else {
      if (!hasMorning && hasAfternoon) {
        lines.push(`<div class="row"><span class="lbl">Student Staff</span><span class="empty">No student staff 9AM-1PM</span></div>`);
      }
      shifts.forEach(shift => {
        const name = shift.name || '';
        const start = timeTo24(shift.startTime) || '09:00';
        const end = shift.endTime ? (timeTo24(shift.endTime) || '17:00') : '17:00';
        const timeLabel = `${fmt12(start)}-${fmt12(end)}`;

        if (isNote(name)) {
          lines.push(`<div class="row"><span class="lbl">Student Staff</span><span class="note">📌 ${name}</span></div>`);
        } else if (isTeamCode(name)) {
          lines.push(`<div class="row"><span class="lbl">Student Staff</span><span class="team">${name} &middot; <span class="muted">${timeLabel}</span></span></div>`);
        } else {
          const link = calLink(`Front Desk (Student): ${name} ${timeLabel}`, data.date, start, end);
          lines.push(`<div class="row"><span class="lbl">Student Staff</span><a href="${link}" class="name">${name} &middot; <span class="muted">${timeLabel}</span><span class="badge">+ Calendar</span></a></div>`);
        }
      });
    }
  }

  lines.push(`</div>`);
  return lines.join('\n');
}

function renderDayCell(dayData) {
  // Returns HTML for a single table cell combining staff + student staff
  if (!dayData) return '<span class="na">-</span>';

  const staff = dayData.staff || null;
  const shifts = dayData.studentShifts || [];
  const lines = [];

  // Staff line
  if (!staff) {
    lines.push(`<span class="na">-</span>`);
  } else if (isHoliday(staff)) {
    lines.push(`<span class="hol">Holiday</span>`);
  } else if (isTeamCode(staff)) {
    lines.push(`<span class="team-sm">${staff}</span>`);
  } else {
    lines.push(`<span class="cell-staff">${staff}</span>`);
  }

  // Student staff lines — italic purple, abbreviated, with time
  shifts.forEach(shift => {
    const name = shift.name || '';
    if (isNote(name) || isHoliday(name)) return;
    const start = timeTo24(shift.startTime) || '09:00';
    const end = shift.endTime ? (timeTo24(shift.endTime) || '17:00') : '17:00';
    const timeLabel = `${fmt12short(start)}-${fmt12short(end)}`;
    const abbr = isTeamCode(name) ? name : firstLast(name);
    lines.push(`<span class="cell-student">${abbr} <span class="cell-time">(${timeLabel})</span></span>`);
  });

  // Morning gap
  const hasMorning = shifts.some(s => (timeTo24(s.startTime)||'09:00') < '13:00');
  const hasAfternoon = shifts.some(s => (timeTo24(s.startTime)||'09:00') >= '13:00');
  if (!hasMorning && hasAfternoon && shifts.length > 0) {
    lines.splice(1, 0, `<span class="cell-student cell-empty">— (9AM-1PM)</span>`);
  }

  if (shifts.length === 0 && staff && !isHoliday(staff)) {
    lines.push(`<span class="cell-student cell-empty">no student staff</span>`);
  }

  return lines.join('<br>');
}

function renderFullSchedule(unique, nextWeek) {
  const DAY_KEYS = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
  const today = new Date();

  const rows = unique.map(w => {
    const wStart = weekStartDate(w.schedule);
    const wEnd = wStart ? new Date(wStart.getTime() + 6*24*60*60*1000) : null;
    const isPast = wEnd && wEnd < today;
    const isCurrent = w.week === nextWeek.week;
    const rowClass = isPast ? 'past-row' : (isCurrent ? 'current-row' : '');

    const dayCells = DAY_KEYS.map(d =>
      `<td>${renderDayCell(w.schedule[d])}</td>`
    ).join('');

    return `<tr class="${rowClass}">
      <td class="wk-col">${w.week}</td>
      ${dayCells}
    </tr>`;
  }).join('\n');

  return `<table class="tbl">
  <thead><tr>
    <th>Week</th><th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`;
}

function generate(scheduleData) {
  const unique = deduplicateWeeks(scheduleData.schedules);
  if (!unique.length) {
    console.log('No schedules found in schedule.json — writing placeholder email.');
    return `<!DOCTYPE html><html><body><p>Schedule data not yet available. Please check back later.</p></body></html>`;
  }
  const nextWeek = getNextWeek(unique);
  const DAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday'];

  const spotlightDays = DAYS.map(d =>
    renderDay(d, nextWeek.schedule[d] || {})
  ).join('\n');

  // Build HTML summary for Teams message
  const teamsDays = DAYS.map(d => {
    const data = nextWeek.schedule[d] || {};
    const date = (data.date || '').toUpperCase();
    const staff = data.staff || null;
    const students = (data.students || []);

    const staffLine = (() => {
      if (!staff) return '<span style="color:#888;font-style:italic;">No staff assigned</span>';
      if (isHoliday(staff)) return '<span style="color:#c62828;font-style:italic;">' + staff + '</span>';
      if (isTeamCode(staff)) return '<span style="color:#6a1b9a;font-weight:600;">' + staff + '</span> <span style="color:#888;font-size:12px;">9AM-5PM</span>';
      return '<strong>' + staff + '</strong> <span style="color:#888;font-size:12px;">9AM-5PM</span>';
    })();

    const studentLines = students.length
      ? students.map(s => {
          const name = (s.name||'').trim().split(/\s+/);
          const abbr = name.length > 1 ? name[0] + ' ' + name[name.length-1][0] + '.' : name[0];
          return '<span style="color:#6a1b9a;font-style:italic;">' + abbr + '</span> <span style="color:#888;font-size:12px;">' + s.startTime + '–' + s.endTime + '</span>';
        }).join('<br>')
      : '<span style="color:#bbb;font-style:italic;">No student staff</span>';

    return '<div style="margin-bottom:12px;border:1px solid #e0e0e0;border-radius:7px;overflow:hidden;">'
      + '<div style="background:#e8eaf6;padding:7px 12px;font-weight:700;font-size:12px;color:#283593;letter-spacing:.05em;">'
      + d.toUpperCase() + (date ? ', ' + date : '')
      + '</div>'
      + '<div style="padding:8px 12px;font-size:13px;line-height:1.8;">'
      + '<span style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.04em;">Staff</span>&nbsp;&nbsp;' + staffLine + '<br>'
      + '<span style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.04em;">Student Staff</span>&nbsp;&nbsp;' + studentLines
      + '</div>'
      + '</div>';
  }).join('');

  const teamsBlock = '<div style="font-family:Arial,sans-serif;max-width:600px;">'
    + '<div style="background:#1a1a2e;color:#fff;padding:14px 16px;border-radius:8px;margin-bottom:14px;">'
    + '<div style="font-size:16px;font-weight:600;">Pathways Center Front Desk Schedule</div>'
    + '<div style="opacity:0.75;font-size:12px;margin-top:3px;">Week of ' + nextWeek.week + '</div>'
    + '</div>'
    + teamsDays
    + '</div>';

  const fullTable = renderFullSchedule(unique, nextWeek);
  const updated = new Date(scheduleData.lastUpdated).toLocaleDateString('en-US',
    { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Pathways Center Front Desk Schedule — ${nextWeek.week}</title>
<style>
  body{font-family:Arial,sans-serif;max-width:760px;margin:0 auto;padding:16px;color:#1a1a1a;font-size:14px;}
  .hdr{background:#1a1a2e;color:#fff;padding:18px 20px;border-radius:8px;margin-bottom:16px;}
  .hdr h1{margin:0 0 4px;font-size:19px;font-weight:600;}
  .hdr p{margin:0;opacity:0.75;font-size:13px;}
  .tip{background:#fff8e1;border-left:4px solid #f9a825;padding:9px 14px;font-size:13px;margin-bottom:18px;border-radius:0 6px 6px 0;}
  .day{margin-bottom:12px;border:1px solid #e0e0e0;border-radius:7px;overflow:hidden;}
  .day-hdr{background:#e8eaf6;padding:8px 14px;font-weight:700;font-size:12px;letter-spacing:.06em;color:#283593;}
  .row{padding:7px 14px;border-top:1px solid #f0f0f0;display:flex;align-items:baseline;gap:10px;}
  .lbl{color:#888;font-size:11px;width:100px;min-width:100px;flex-shrink:0;text-transform:uppercase;letter-spacing:.04em;}
  .name{color:#1565c0;text-decoration:none;font-weight:500;font-size:14px;}
  .name:hover{text-decoration:underline;}
  .badge{background:#e3f2fd;color:#1565c0;font-size:10px;padding:1px 7px;border-radius:10px;margin-left:8px;font-weight:400;white-space:nowrap;}
  .muted{color:#444;font-size:14px;font-weight:400;}
  .empty{color:#bbb;font-style:italic;}
  .team{color:#6a1b9a;font-weight:500;font-size:14px;}
  .note{color:#e65100;}
  .holiday{color:#c62828;font-style:italic;padding:8px 14px;}
  .sec{font-size:15px;font-weight:700;margin:24px 0 10px;padding-bottom:6px;border-bottom:2px solid #e8eaf6;color:#283593;}
  .tbl{width:100%;border-collapse:collapse;font-size:11px;}
  .tbl th{background:#e8eaf6;padding:7px 8px;text-align:left;color:#283593;font-weight:600;border-bottom:2px solid #c5cae9;}
  .tbl td{padding:6px 8px;border-bottom:1px solid #f0f0f0;vertical-align:top;line-height:1.6;}
  .wk-col{font-weight:600;white-space:nowrap;color:#444;font-size:11px;}
  .cell-staff{font-weight:600;color:#1a1a1a;display:block;}
  .cell-student{font-style:italic;color:#6a1b9a;display:block;font-size:10.5px;}
  .cell-time{color:#5c35a0;font-style:normal;font-size:10.5px;}
  .cell-empty{color:#ccc;font-style:italic;}
  .team-sm{color:#6a1b9a;font-size:11px;font-weight:600;}
  .hol{color:#c62828;font-size:11px;font-weight:600;}
  .na{color:#ddd;}
  .past-row td{opacity:0.35;}
  .current-row td{background:#fffde7;}
  .canva{margin-top:20px;padding:12px 16px;background:#f3e5f5;border-radius:7px;font-size:13px;}
  .canva a{color:#6a1b9a;font-weight:600;}
  .footer{margin-top:20px;font-size:11px;color:#aaa;border-top:1px solid #f0f0f0;padding-top:12px;}
</style>
</head><body>
<!-- SUBJECT: Pathways Center Front Desk Schedule — ${nextWeek.week} -->

<div class="hdr">
  <h1>Pathways Center Front Desk Schedule</h1>
  <p>Week of ${nextWeek.week}</p>
</div>

<div class="tip">👆 Click any name to add that shift to your Outlook calendar.</div>

${spotlightDays}

<div class="sec">Full Schedule</div>
${fullTable}

<div class="canva">
  Need to make a change? <a href="${CANVA_URL}">Open the schedule in Canva →</a>
</div>

<div class="footer">
  Sent automatically every Friday. Schedule last updated: ${updated}.
</div>

<!--TEAMS:
${teamsBlock}
END-TEAMS-->
</body></html>`;
}

const data = JSON.parse(fs.readFileSync('schedule.json', 'utf8'));
// Derive subject from the same week selection logic used in generate()
const unique = deduplicateWeeks(data.schedules || []);
const weekForSubject = unique.length ? getNextWeek(unique) : null;
const subject = weekForSubject
  ? `Pathways Center Front Desk Schedule — ${weekForSubject.week}`
  : 'Pathways Center Front Desk Schedule';
const html = generate(data);
fs.writeFileSync('email-body.html', html);
console.log('email-body.html written.');
fs.writeFileSync('email-subject.txt', subject, 'utf8');
console.log('email-subject.txt: ' + subject);
