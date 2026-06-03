// Minimal iCalendar parser/generator supporting VEVENT, VTODO, VJOURNAL
// Handles the common subset needed for CalDAV interop.

// Parse an .ics string into structured data
export function parseIcs(icsText) {
	const lines = icsText.split(/\r?\n/);
	let inComponent = false;
	let componentType = '';
	const event = {};
	let currentLine = '';

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];

		// Handle continuation lines (RFC 5545 line folding)
		if (lines[i + 1] && (lines[i + 1].startsWith(' ') || lines[i + 1].startsWith('\t'))) {
			currentLine = line;
			while (lines[i + 1] && (lines[i + 1].startsWith(' ') || lines[i + 1].startsWith('\t'))) {
				i++;
				currentLine += lines[i].substring(1);
			}
			line = currentLine;
		}

		if (line.startsWith('BEGIN:VEVENT') || line.startsWith('BEGIN:VTODO') || line.startsWith('BEGIN:VJOURNAL')) {
			inComponent = true;
			componentType = line.substring(6);
			event.componentType = componentType;
			continue;
		}
		if (line.startsWith('END:VEVENT') || line.startsWith('END:VTODO') || line.startsWith('END:VJOURNAL')) {
			inComponent = false;
			continue;
		}
		if (line.startsWith('BEGIN:VCALENDAR') || line.startsWith('END:VCALENDAR')) {
			continue;
		}
		if (!inComponent) continue;

		const colonIdx = line.indexOf(':');
		if (colonIdx === -1) continue;

		const field = line.substring(0, colonIdx);
		const value = line.substring(colonIdx + 1);

		// Parse field name (strip parameters like ;VALUE=DATE)
		const semiIdx = field.indexOf(';');
		const fieldName = semiIdx !== -1 ? field.substring(0, semiIdx) : field;
		const params = semiIdx !== -1 ? parseParams(field.substring(semiIdx + 1)) : {};

		switch (fieldName) {
			case 'UID':
				event.uid = value;
				break;
			case 'SUMMARY':
				event.summary = value;
				break;
			case 'DESCRIPTION':
				event.description = value;
				break;
			case 'LOCATION':
				event.location = value;
				break;
			case 'CLASS':
				event.class = value;
				break;
			case 'DTSTART':
				event.dtstart = normalizeDate(value, params);
				event.dtstartRaw = value;
				if (params.TZID) event.dtstartTzid = params.TZID;
				break;
			case 'DTEND':
				event.dtend = normalizeDate(value, params);
				event.dtendRaw = value;
				if (params.TZID) event.dtendTzid = params.TZID;
				break;
			case 'DURATION':
				event.duration = value;
				break;
			case 'DTSTAMP':
				event.dtstamp = value;
				break;
			case 'CREATED':
				event.created = value;
				break;
			case 'LAST-MODIFIED':
				event.lastModified = value;
				break;
			case 'RRULE':
				event.rrule = value;
				break;
			case 'PRIORITY':
				event.priority = value;
				break;
			case 'STATUS':
				event.status = value;
				break;
			case 'ORGANIZER':
				event.organizer = extractCn(value);
				break;
			case 'ATTENDEE':
				if (!event.attendees) event.attendees = [];
				event.attendees.push(extractCn(value));
				break;
			// VTODO fields
			case 'DUE':
				event.due = normalizeDate(value, params);
				event.dueRaw = value;
				if (params.TZID) event.dueTzid = params.TZID;
				break;
			case 'COMPLETED':
				event.completed = value;
				break;
			case 'PERCENT-COMPLETE':
				event.percentComplete = value;
				break;
			default:
				// Capture any unknown properties for round-trip
				if (fieldName.trim() && !fieldName.startsWith('X-')) {
					if (!event._extra) event._extra = [];
					event._extra.push({ field, value });
				}
		}
	}

	return event;
}

function parseParams(paramsStr) {
	const params = {};
	const parts = paramsStr.split(';');
	for (const p of parts) {
		const eqIdx = p.indexOf('=');
		if (eqIdx !== -1) {
			params[p.substring(0, eqIdx)] = p.substring(eqIdx + 1);
		} else {
			params[p] = true;
		}
	}
	return params;
}

function normalizeDate(value, params) {
	// If it's a DATE type, append T000000Z for comparison purposes
	if (params.VALUE === 'DATE') {
		return value + 'T000000Z';
	}
	// Already has time component
	return value;
}

function extractCn(value) {
	const cnMatch = value.match(/CN="?([^";]+)"?/);
	return cnMatch ? cnMatch[1] : value.split(':').pop();
}

// Generate .ics string from event data
export function generateIcs(event) {
	const comp = event.componentType || 'VEVENT';
	const lines = [];
	lines.push('BEGIN:VCALENDAR');
	lines.push('VERSION:2.0');
	lines.push('PRODID:-//CalDAV Worker//EN');
	lines.push(`BEGIN:${comp}`);

	if (event.uid) lines.push(`UID:${event.uid}`);
	if (event.summary) {
		const escaped = escapeIcsText(event.summary);
		lines.push(`SUMMARY:${escaped}`);
	}
	if (event.description) {
		const escaped = escapeIcsText(event.description);
		lines.push(`DESCRIPTION:${escaped}`);
	}
	if (event.location) {
		const escaped = escapeIcsText(event.location);
		lines.push(`LOCATION:${escaped}`);
	}
	if (event.dtstart) lines.push(`DTSTART:${event.dtstart}`);
	if (event.dtend) lines.push(`DTEND:${event.dtend}`);
	if (event.due) lines.push(`DUE:${event.due}`);
	if (event.completed) lines.push(`COMPLETED:${event.completed}`);
	if (event.percentComplete !== undefined) lines.push(`PERCENT-COMPLETE:${event.percentComplete}`);
	if (event.duration) lines.push(`DURATION:${event.duration}`);
	if (event.dtstamp) lines.push(`DTSTAMP:${event.dtstamp}`);
	else lines.push(`DTSTAMP:${utcNow()}`);
	if (event.class) lines.push(`CLASS:${event.class}`);
	if (event.priority) lines.push(`PRIORITY:${event.priority}`);
	if (event.status) lines.push(`STATUS:${event.status}`);
	if (event.rrule) lines.push(`RRULE:${event.rrule}`);
	if (event.organizer) lines.push(`ORGANIZER;CN=${event.organizer}:mailto:${event.organizer}`);
	if (event.attendees) {
		for (const a of event.attendees) {
			lines.push(`ATTENDEE;CN=${a}:mailto:${a}`);
		}
	}
	if (event.lastModified) lines.push(`LAST-MODIFIED:${event.lastModified}`);

	lines.push(`END:${comp}`);
	lines.push('END:VCALENDAR');
	return lines.join('\r\n') + '\r\n';
}

function escapeIcsText(text) {
	return text
		.replace(/\\/g, '\\\\')
		.replace(/\n/g, '\\n')
		.replace(/;/g, '\\;')
		.replace(/,/g, '\\,');
}

function utcNow() {
	const d = new Date();
	return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Extract DTSTART/DTEND from raw .ics for database storage
// Converts TZID times to UTC for consistent querying
export function extractTimeRange(icsText) {
	const parsed = parseIcs(icsText);
	const isTodo = parsed.componentType === 'VTODO';
	const tzid = parsed.dtstartTzid || parsed.dtendTzid || parsed.dueTzid || null;
	let dtstart = parsed.dtstart || parsed.due || '19700101T000000Z';
	let dtend = parsed.dtend || parsed.due;

	// VTODO: use DUE as the end boundary; default to far future if no DUE
	if (isTodo && !dtend) {
		dtend = '99991231T235959Z';
	} else if (!dtend) {
		if (parsed.duration) {
			dtend = applyDuration(dtstart, parsed.duration);
		} else {
			dtend = dtstart;
		}
	}

	// Convert TZID local times to UTC for proper time-range queries
	if (tzid && !dtstart.endsWith('Z')) {
		dtstart = tzidToUTC(dtstart, tzid);
	}
	if (tzid && dtend && !dtend.endsWith('Z')) {
		dtend = tzidToUTC(dtend, tzid);
	}

	return { dtstart, dtend };
}

// Convert a local datetime string to UTC based on timezone
function tzidToUTC(dtString, tzid) {
	if (tzid === 'Asia/Shanghai') {
		const m = dtString.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
		if (!m) return dtString;
		// Asia/Shanghai is UTC+8
		const utc = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 8 * 3600000);
		return utc.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
	}
	return dtString;
}

function applyDuration(dtstart, durationStr) {
	// Minimal positive duration parser: P[nW][nD][T[nH][nM][nS]]
	const match = durationStr.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
	if (!match) return dtstart;
	const weeks = parseInt(match[1] || '0');
	const days = parseInt(match[2] || '0');
	const hours = parseInt(match[3] || '0');
	const mins = parseInt(match[4] || '0');
	const secs = parseInt(match[5] || '0');
	const totalMs = (((weeks * 7 + days) * 24 + hours) * 60 + mins) * 60 * 1000 + secs * 1000;

	// Parse dtstart - simple ISO 8601 format
	const isoStr = dtstart.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/, '$1-$2-$3T$4:$5:$6Z');
	const d = new Date(isoStr);
	if (isNaN(d.getTime())) return dtstart;
	const end = new Date(d.getTime() + totalMs);
	return end.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
