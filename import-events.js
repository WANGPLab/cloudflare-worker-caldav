// Import script: parse .ics file and generate SQL for D1
// Handles VEVENT, VTODO, VJOURNAL
const fs = require('fs');

const icsContent = fs.readFileSync('./fruux-Calendar.ics', 'utf-8');

// Convert TZID=Asia/Shanghai local time to UTC
// China uses UTC+8 year-round (no DST since 1991)
function toUTC(dtString, tzid) {
	if (!tzid || tzid !== 'Asia/Shanghai') return dtString;
	if (dtString.endsWith('Z')) return dtString;

	const match = dtString.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
	if (!match) return dtString;

	const [, y, m, d, h, mi, s] = match;
	const utc = new Date(Date.UTC(+y, +m - 1, +d, +h, +mi, +s) - 8 * 3600000);
	return utc.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Match VEVENT, VTODO, VJOURNAL blocks
const compRegex = /BEGIN:(VEVENT|VTODO|VJOURNAL)\r?\n([\s\S]*?)END:\1/g;
const sqlStatements = [];
let match;

while ((match = compRegex.exec(icsContent)) !== null) {
	const compType = match[1];
	const body = match[2];

	const uidMatch = body.match(/^UID:(.+)$/m);
	if (!uidMatch) continue;
	const uid = uidMatch[1].trim().replace(/\r$/, '');

	// DTSTART (or DUE for VTODO without DTSTART)
	const dtstartMatch = body.match(/^DTSTART(?:;([^:]*))?:(.+)$/m);
	const dueMatch = body.match(/^DUE(?:;([^:]*))?:(.+)$/m);
	let dtstartRaw, dtstartParams;

	if (dtstartMatch) {
		dtstartParams = dtstartMatch[1] || '';
		dtstartRaw = dtstartMatch[2].trim().replace(/\r$/, '');
	} else if (dueMatch) {
		dtstartParams = dueMatch[1] || '';
		dtstartRaw = dueMatch[2].trim().replace(/\r$/, '');
	} else {
		dtstartParams = '';
		dtstartRaw = '19700101T000000';
	}

	// DTEND, DUE, or derived
	const dtendMatch = body.match(/^DTEND(?:;([^:]*))?:(.+)$/m);
	let dtendRaw;
	if (dtendMatch) {
		dtendRaw = dtendMatch[2].trim().replace(/\r$/, '');
	} else if (compType === 'VTODO' && dueMatch) {
		dtendRaw = dueMatch[2].trim().replace(/\r$/, '');
	} else if (compType === 'VTODO') {
		dtendRaw = '99991231T235959Z'; // open-ended task
	} else {
		dtendRaw = dtstartRaw;
	}

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

	// Build full ICS component
	const fullItem = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//CalDAV Worker//EN\r\n` +
		`BEGIN:${compType}\r\n` + body + `END:${compType}\r\nEND:VCALENDAR\r\n`;

	const esc = (s) => s.replace(/'/g, "''");

	// content_type indicates the component type for the object
	const contentType = `text/calendar; component=${compType.toLowerCase()}`;

	sqlStatements.push(
		`INSERT OR REPLACE INTO events (calendar_id, uid, ics_data, dtstart, dtend) ` +
		`VALUES (1, '${esc(uid)}', '${esc(fullItem)}', '${esc(dtstart)}', '${esc(dtend)}');`
	);
}

const sqlFile = sqlStatements.join('\n');
fs.writeFileSync('./migrations/002_import_events.sql', sqlFile);
console.log(`Generated ${sqlStatements.length} INSERT statements → migrations/002_import_events.sql`);
console.log('Run: npx wrangler d1 execute caldav-db --remote --file=migrations/002_import_events.sql');
