import { DAV_HEADERS, buildMultistatus, buildCalendarResource, buildEventList, parseReportBody, buildError } from './xml';
import { parseIcs, generateIcs, extractTimeRange } from './ical';
import { getCalendar, listCalendars, createCalendar, deleteCalendar, getEvent, listEvents, upsertEvent, deleteEvent } from './db';
import { authenticate, authChallengeResponse } from './auth';

// Path patterns:
//   /                       → 404
//   /<owner>/               → PROPFIND: list calendars / principal discovery
//   /<owner>/<calendar>/     → PROPFIND: list events in calendar, REPORT, MKCALENDAR
//   /<owner>/<calendar>/<uid>.ics → GET/PUT/DELETE event

function parsePath(pathname) {
	const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
	if (parts.length === 0) return { owner: null, calendar: null, uid: null };
	if (parts.length === 1) return { owner: parts[0], calendar: null, uid: null };
	if (parts.length === 2) return { owner: parts[0], calendar: parts[1], uid: null };
	// 3+ parts: /owner/calendar/sub/...  or /owner/calendar/uid.ics
	const last = parts[parts.length - 1];
	if (last.endsWith('.ics')) {
		return { owner: parts[0], calendar: parts[1], uid: last.replace(/\.ics$/, '') };
	}
	return { owner: parts[0], calendar: parts[1], uid: null };
}

export default {
	async fetch(request, env) {
		if (!authenticate(request, env)) {
			return authChallengeResponse();
		}

		const url = new URL(request.url);
		let method = request.method.toUpperCase();

		// Workaround: local wrangler dev rejects MKCALENDAR method.
		// Accept POST with X-Method-Override header as a substitute.
		const override = request.headers.get('X-Method-Override');
		if (method === 'POST' && override) {
			method = override.toUpperCase();
		}

		const { owner, calendar, uid } = parsePath(url.pathname);

		if (!owner) {
			return new Response('Not Found', { status: 404 });
		}

		const calPath = calendar ? `/${owner}/${calendar}/` : null;

		switch (method) {
			case 'OPTIONS':
				return handleOptions();
			case 'PROPFIND':
				return await handlePropfind(env, owner, calPath, request);
			case 'REPORT':
				return await handleReport(env, owner, calPath, request);
			case 'GET':
				return await handleGet(env, calPath, uid);
			case 'PUT':
				return await handlePut(env, calPath, uid, request);
			case 'DELETE':
				return await handleDelete(env, calPath, uid);
			case 'MKCALENDAR':
				return await handleMkcalendar(env, owner, calPath, request);
			default:
				return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE, MKCALENDAR' } });
		}
	},
};

function handleOptions() {
	return new Response(null, {
		status: 200,
		headers: {
			...DAV_HEADERS,
			Allow: 'OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE, MKCALENDAR',
		},
	});
}

// Parse the PROPFIND body to extract requested property names
function parsePropfindBody(text) {
	if (!text) return [];
	const props = [];
	const regex = /<(?:D:)?(getetag|getcontenttype|resourcetype|displayname|getctag|current-user-principal|calendar-home-set|supported-report-set|principal-URL|principal-collection-set|calendar-user-address-set|owner)\s*\/?>/gi;
	let m;
	while ((m = regex.exec(text)) !== null) {
		props.push(m[1]);
	}
	return props;
}

async function handlePropfind(env, owner, calPath, request) {
	const db = env.CALDAV_DB;
	let body = '';
	try { body = await request.text(); } catch (e) { /* ignore */ }
	const requestedProps = parsePropfindBody(body);
	const depth = request.headers.get('Depth') || 'infinity';

	// Principal discovery: PROPFIND on /user/ asking for current-user-principal
	const wantsPrincipal = requestedProps.includes('current-user-principal');
	const wantsHome = requestedProps.includes('calendar-home-set');
	const isPrincipalProbe = !calPath && (wantsPrincipal || wantsHome);

	if (isPrincipalProbe) {
		return handlePrincipalDiscovery(owner);
	}

	if (calPath) {
		const cal = await getCalendar(db, calPath);
		if (!cal) return new Response(buildError('not-found'), { status: 404, headers: DAV_HEADERS });

		if (depth === '0') {
			// Only return the calendar resource itself, no child events
			const responses = buildCalendarResource(cal, []);
			return new Response(buildMultistatus(responses), { status: 207, headers: DAV_HEADERS });
		}

		const events = await listEvents(db, calPath, null, null);
		const responses = buildCalendarResource(cal, events);
		return new Response(buildMultistatus(responses), { status: 207, headers: DAV_HEADERS });
	}

	// PROPFIND on the user's root — list all calendars
	const calendars = await listCalendars(db, owner);
	const responses = [];
	for (const cal of calendars) {
		responses.push(...buildCalendarResource(cal, []));
	}
	return new Response(buildMultistatus(responses), { status: 207, headers: DAV_HEADERS });
}

function handlePrincipalDiscovery(owner) {
	const principalUrl = `/${owner}/`;
	const calHomeUrl = `/${owner}/`;

	const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>${principalUrl}</D:href>
    <D:propstat>
      <D:prop>
        <D:current-user-principal><D:href>${principalUrl}</D:href></D:current-user-principal>
        <C:calendar-home-set><D:href>${calHomeUrl}</D:href></C:calendar-home-set>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:displayname>${owner}'s Calendars</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

	return new Response(xml, { status: 207, headers: DAV_HEADERS });
}

async function handleReport(env, owner, calPath, request) {
	if (!calPath) {
		return new Response(buildError('not-found'), { status: 404, headers: DAV_HEADERS });
	}

	const db = env.CALDAV_DB;
	const cal = await getCalendar(db, calPath);
	if (!cal) return new Response(buildError('not-found'), { status: 404, headers: DAV_HEADERS });

	const body = await request.text();
	const query = parseReportBody(body);

	let events;
	if (query.start && query.end) {
		events = await listEvents(db, calPath, query.start, query.end);
	} else {
		events = await listEvents(db, calPath, null, null);
	}

	const responses = buildCalendarResource(cal, events, true);
	return new Response(buildMultistatus(responses), { status: 207, headers: DAV_HEADERS });
}

async function handleGet(env, calPath, uid) {
	if (!calPath || !uid) {
		return new Response('Not Found', { status: 404 });
	}

	const db = env.CALDAV_DB;
	const event = await getEvent(db, calPath, uid);
	if (!event) return new Response('Not Found', { status: 404 });

	return new Response(event.ics_data, {
		status: 200,
		headers: {
			'Content-Type': 'text/calendar; charset=utf-8',
			ETag: `"${event.updated}"`,
		},
	});
}

async function handlePut(env, calPath, uid, request) {
	if (!calPath || !uid) {
		return new Response('Not Found', { status: 404 });
	}

	const db = env.CALDAV_DB;
	const cal = await getCalendar(db, calPath);
	if (!cal) return new Response(buildError('not-found'), { status: 404, headers: DAV_HEADERS });

	const ifMatch = request.headers.get('If-Match');
	const ifNoneMatch = request.headers.get('If-None-Match');

	const existing = await getEvent(db, calPath, uid);

	if (ifMatch && existing) {
		const expected = ifMatch.replace(/^"|"$/g, '');
		if (existing.updated !== expected) {
			return new Response('Precondition Failed', { status: 412 });
		}
	}
	if (ifNoneMatch === '*' && existing) {
		return new Response('Precondition Failed', { status: 412 });
	}

	const icsData = await request.text();
	const parsed = parseIcs(icsData);

	const eventUid = parsed.uid || uid;
	if (existing && eventUid !== uid) {
		return new Response('UID Mismatch', { status: 409 });
	}

	const { dtstart, dtend } = extractTimeRange(icsData);

	if (!dtstart) {
		return new Response('Missing DTSTART', { status: 400 });
	}

	await upsertEvent(db, calPath, uid, icsData, dtstart, dtend || dtstart);

	return new Response(null, {
		status: existing ? 204 : 201,
		headers: { ETag: `"${new Date().toISOString()}"` },
	});
}

async function handleDelete(env, calPath, uid) {
	const db = env.CALDAV_DB;

	if (uid) {
		if (!calPath) return new Response('Not Found', { status: 404 });
		const deleted = await deleteEvent(db, calPath, uid);
		if (!deleted) return new Response('Not Found', { status: 404 });
		return new Response(null, { status: 204 });
	}

	if (calPath) {
		const cal = await getCalendar(db, calPath);
		if (!cal) return new Response('Not Found', { status: 404 });
		await deleteCalendar(db, calPath);
		return new Response(null, { status: 204 });
	}

	return new Response('Not Found', { status: 404 });
}

async function handleMkcalendar(env, owner, calPath, request) {
	if (!calPath) {
		return new Response('Bad Request', { status: 400 });
	}

	const db = env.CALDAV_DB;
	const existing = await getCalendar(db, calPath);
	if (existing) return new Response('Calendar already exists', { status: 409 });

	let calName = calPath.split('/').filter(Boolean).pop();
	let description = '';
	let color = '#3366CC';

	if (request.body) {
		try {
			const body = await request.text();
			const nameMatch = body.match(/<D:displayname>([^<]+)<\/D:displayname>/);
			if (nameMatch) calName = nameMatch[1];
			const descMatch = body.match(/<C:calendar-description[^>]*>([^<]+)<\/C:calendar-description>/);
			if (descMatch) description = descMatch[1];
			const colorMatch = body.match(/<!\[CDATA\[([^\]]+)\]\]>/);
			if (colorMatch) color = colorMatch[1];
		} catch (e) { /* ignore */ }
	}

	await createCalendar(db, owner, calPath, calName, description, color);
	return new Response(null, { status: 201 });
}
