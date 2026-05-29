// CalDAV XML constants
const DAV_NS = 'DAV:';
const CALDAV_NS = 'urn:ietf:params:xml:ns:caldav';
const CS_NS = 'http://calendarserver.org/ns/';

function tag(ns, name, content, attrs) {
	let attrStr = '';
	if (attrs) {
		for (const [k, v] of Object.entries(attrs)) {
			attrStr += ` ${k}="${escXml(v)}"`;
		}
	}
	if (ns === 'DAV:') {
		return `<D:${name}${attrStr}>${content !== undefined ? content : ''}</D:${name}>`;
	}
	if (ns === CALDAV_NS) {
		return `<C:${name}${attrStr}>${content !== undefined ? content : ''}</C:${name}>`;
	}
	if (ns === CS_NS) {
		return `<CS:${name}${attrStr}>${content !== undefined ? content : ''}</CS:${name}>`;
	}
	return `<${name}${attrStr}>${content !== undefined ? content : ''}</${name}>`;
}

function escXml(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const DAV_HEADERS = {
	'DAV': '1, 2, 3, calendar-access, addressbook',
	'Content-Type': 'application/xml; charset=utf-8',
};

// Build a <D:multistatus> response from an array of response objects.
// Each response: { href, propstat: [{ status, props: { ns, name, value, [attrs] } }] }
export function buildMultistatus(responses) {
	let xml = `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">`;
	for (const r of responses) {
		xml += `<D:response><D:href>${escXml(r.href)}</D:href>`;
		for (const ps of r.propstat) {
			xml += buildPropstatElement(ps.props, ps.status);
		}
		xml += `</D:response>`;
	}
	xml += `</D:multistatus>`;
	return xml;
}

function buildPropstatElement(props, status) {
	let xml = '<D:propstat><D:prop>';
	for (const p of props) {
		if (p.value !== undefined) {
			xml += tag(p.ns || 'DAV:', p.name, escXml(p.value), p.attrs);
		} else if (p.children) {
			xml += tag(p.ns || 'DAV:', p.name, p.children, p.attrs);
		} else {
			xml += tag(p.ns || 'DAV:', p.name, '', p.attrs);
		}
	}
	xml += `</D:prop><D:status>${status}</D:status></D:propstat>`;
	return xml;
}

// Build a DAV:href list for a calendar's events
// If includeData is true, include the .ics content as calendar-data
export function buildEventList(calendarPath, events, includeData) {
	const res = [];
	for (const ev of events) {
		const props = [
			{ ns: 'DAV:', name: 'resourcetype', children: '', attrs: undefined },
			{ ns: 'DAV:', name: 'getcontenttype', value: 'text/calendar; component=vevent' },
			{ ns: 'DAV:', name: 'getetag', value: `"${ev.updated}"` },
		];
		if (includeData) {
			props.push({ ns: CALDAV_NS, name: 'calendar-data', value: ev.ics_data });
		}
		res.push({
			href: `${calendarPath}${ev.uid}.ics`,
			propstat: [{
				status: 'HTTP/1.1 200 OK',
				props,
			}],
		});
	}
	return res;
}

const SUPPORTED_REPORTS = '<D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report>' +
	'<D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report>';

// Build the calendar collection resource
// Set includeData=true for REPORT responses that need calendar-data
export function buildCalendarResource(calendar, events, includeData) {
	const res = [{
		href: calendar.path,
		propstat: [{
			status: 'HTTP/1.1 200 OK',
			props: [
				{ ns: 'DAV:', name: 'resourcetype', children: '<D:collection/><C:calendar/>' },
				{ ns: 'DAV:', name: 'displayname', value: calendar.name },
				{ ns: 'DAV:', name: 'getetag', value: `"${calendar.updated}"` },
				{ ns: CS_NS, name: 'getctag', value: calendar.updated },
				{ ns: 'DAV:', name: 'supported-report-set', children: SUPPORTED_REPORTS },
			],
		}],
	}];

	if (events) {
		res.push(...buildEventList(calendar.path, events, includeData));
	}
	return res;
}

// Parse REPORT request body to extract time-range filter
export function parseReportBody(text) {
	const rangeMatch = text.match(/<C:time-range[^>]*\sstart="([^"]*)"\send="([^"]*)"/);
	const endMatch = text.match(/<C:time-range[^>]*\send="([^"]*)"\sstart="([^"]*)"/);
	let start = null, end = null;
	if (rangeMatch) {
		start = rangeMatch[1];
		end = rangeMatch[2];
	} else if (endMatch) {
		start = endMatch[2];
		end = endMatch[1];
	}

	const propTags = [];
	const propRegex = /<(?:\w+:)?(getetag|calendar-data|getcontenttype|resourcetype|displayname|getctag)\s*\/>/gi;
	let m;
	while ((m = propRegex.exec(text)) !== null) {
		propTags.push(m[1]);
	}

	return { start, end, propTags };
}

// Build XML error response
export function buildError(detail) {
	return `<?xml version="1.0" encoding="utf-8"?>
<D:error xmlns:D="DAV:">
${detail ? '<D:' + escXml(detail) + '/>' : ''}
</D:error>`;
}

// Build calendar-query REPORT response
export function buildCalendarQueryResponse(calendarPath, events) {
	const responses = [];
	responses.push(...buildCalendarResource(undefined, []));
	responses.push(...buildEventList(calendarPath, events));
	return buildMultistatus(responses);
}
