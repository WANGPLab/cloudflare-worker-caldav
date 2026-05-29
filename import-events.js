// Import script: parse fruux-Calendar.ics and generate SQL for D1
const fs = require('fs');

const icsContent = fs.readFileSync('./fruux-Calendar.ics', 'utf-8');

// Convert TZID=Asia/Shanghai local time to UTC
// China uses UTC+8 year-round (no DST since 1991)
function toUTC(dtString, tzid) {
	if (!tzid || tzid !== 'Asia/Shanghai') return dtString;
	if (dtString.endsWith('Z')) return dtString;

	const match = dtString.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
	if (!match) return dtString; // VALUE=DATE format, already handled

	const [, y, m, d, h, mi, s] = match;
	// Asia/Shanghai is UTC+8: subtract 8 hours to get UTC
	const utc = new Date(Date.UTC(+y, +m - 1, +d, +h, +mi, +s) - 8 * 3600000);
	return utc.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const veventRegex = /BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g;
const sqlStatements = [];
let match;

while ((match = veventRegex.exec(icsContent)) !== null) {
	const body = match[1];

	const uidMatch = body.match(/^UID:(.+)$/m);
	if (!uidMatch) continue;
	const uid = uidMatch[1].trim().replace(/\r$/, '');

	const dtstartMatch = body.match(/^DTSTART(?:;([^:]*))?:(.+)$/m);
	if (!dtstartMatch) continue;
	const dtstartParams = dtstartMatch[1] || '';
	const dtstartRaw = dtstartMatch[2].trim().replace(/\r$/, '');

	const dtendMatch = body.match(/^DTEND(?:;([^:]*))?:(.+)$/m);
	const dtendRaw = dtendMatch ? dtendMatch[2].trim().replace(/\r$/, '') : dtstartRaw;

	const isDate = dtstartParams.includes('VALUE=DATE');
	const tzidMatch = dtstartParams.match(/TZID=([^;]+)/);
	const tzid = tzidMatch ? tzidMatch[1] : null;

	let dtstart = dtstartRaw;
	let dtend = dtendRaw;
	if (isDate) {
		if (!dtstart.includes('T')) dtstart = dtstart + 'T000000Z';
		if (!dtend.includes('T')) dtend = dtend + 'T000000Z';
	} else if (tzid) {
		dtstart = toUTC(dtstart, tzid);
		dtend = toUTC(dtend, tzid);
	}

	const fullVevent = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//CalDAV Worker//EN\r\n' +
		'BEGIN:VEVENT\r\n' + body + 'END:VEVENT\r\nEND:VCALENDAR\r\n';

	const esc = (s) => s.replace(/'/g, "''");

	sqlStatements.push(
		`INSERT OR REPLACE INTO events (calendar_id, uid, ics_data, dtstart, dtend) ` +
		`VALUES (1, '${esc(uid)}', '${esc(fullVevent)}', '${esc(dtstart)}', '${esc(dtend)}');`
	);
}

const sqlFile = sqlStatements.join('\n');
fs.writeFileSync('./migrations/002_import_events.sql', sqlFile);
console.log(`Generated ${sqlStatements.length} INSERT statements → migrations/002_import_events.sql`);
console.log('Run: npx wrangler d1 execute caldav-db --remote --file=migrations/002_import_events.sql');
