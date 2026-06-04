import { DAV_HEADERS, buildMultistatus, buildCalendarResource, buildEventList, parseReportBody, buildError, CALDAV_NS } from './xml';
import { parseIcs, generateIcs, extractTimeRange } from './ical';
import { getCalendar, listCalendars, createCalendar, deleteCalendar, getEvent, listEvents, upsertEvent, deleteEvent } from './db';
import { authenticate, authChallengeResponse } from './auth';
import { registerUser, changePassword, changeUsername, authenticateUser, deleteUser } from './users';

// Path patterns:
//   /api/register             → POST: create user
//   /api/change-password      → POST: change password
//   /api/change-username      → POST: change username
//   /<owner>/                 → PROPFIND: list calendars / principal discovery
//   /<owner>/<calendar>/      → PROPFIND/REPORT/MKCALENDAR on a calendar
//   /<owner>/<calendar>/<uid>.ics → GET/PUT/DELETE event

function parsePath(pathname) {
	const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
	if (parts.length === 0) return { owner: null, calendar: null, uid: null };
	if (parts.length === 1) return { owner: parts[0], calendar: null, uid: null };
	if (parts.length === 2) return { owner: parts[0], calendar: parts[1], uid: null };
	const last = parts[parts.length - 1];
	if (last.endsWith('.ics')) {
		return { owner: parts[0], calendar: parts[1], uid: last.replace(/\.ics$/, '') };
	}
	return { owner: parts[0], calendar: parts[1], uid: null };
}

async function jsonResponse(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

const DEBUG = false; // Set false to disable debug logging

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		let method = request.method.toUpperCase();

		if (DEBUG) {
			const cloned = request.clone();
			const body = await cloned.text().catch(() => '(unreadable)');
			console.log(`\n=== ${method} ${url.pathname} ===`);
			console.log(`Host: ${url.host}  Auth: ${request.headers.get('Authorization') ? 'yes' : 'no'}`);
			console.log(`Body (first 500): ${body.substring(0, 500)}`);
		}

		const override = request.headers.get('X-Method-Override');
		if (method === 'POST' && override && override.toUpperCase() !== 'POST') {
			method = override.toUpperCase();
		}

		let response;

		// --- CORS preflight ---
		if (method === 'OPTIONS') {
			const corsHeaders = {
				'Access-Control-Allow-Origin': '*',
				'Access-Control-Allow-Methods': 'GET, PUT, DELETE, PROPFIND, REPORT, OPTIONS, MKCALENDAR',
				'Access-Control-Allow-Headers': 'Authorization, Content-Type, Depth, If-Match, If-None-Match',
				'Access-Control-Max-Age': '86400',
			};
			if (request.headers.get('Access-Control-Request-Method')) {
				return new Response(null, { status: 204, headers: corsHeaders });
			}
		}

		// --- API routes (admin-password auth, no CalDAV auth needed) ---
		if (url.pathname === '/api/register' && method === 'POST') {
			response = handleApiRegister(env, request);
		} else if (url.pathname === '/api/delete-user' && method === 'POST') {
			response = handleApiDeleteUser(env, request);
		} else {
			// --- Auth required for everything else ---
			const auth = await authenticate(request, env);
			if (!auth) {
				response = authChallengeResponse();
			} else {
				const authUser = auth.username;
				if (url.pathname === '/api/change-password' && method === 'POST') {
					response = handleApiChangePassword(env, authUser, request);
				} else if (url.pathname === '/api/change-username' && method === 'POST') {
					response = handleApiChangeUsername(env, authUser, request);
				} else {
					// --- CalDAV routes ---
					const { owner, calendar, uid } = parsePath(url.pathname);

					if (url.pathname === '/.well-known/caldav' || url.pathname === '/') {
						if (method === 'PROPFIND') {
							response = handlePrincipalDiscovery(authUser);
						} else {
							response = new Response(null, { status: 301, headers: { Location: `/${authUser}/` } });
						}
					} else if (!owner) {
						response = new Response('Not Found', { status: 404 });
					} else if (owner !== authUser) {
						response = new Response(`Forbidden: owner=${owner} user=${authUser}`, { status: 403, headers: DAV_HEADERS });
					} else {
						const calPath = calendar ? `/${owner}/${calendar}/` : null;
		switch (method) {
			case 'OPTIONS':
				response = handleOptions(); break;
			case 'PROPFIND':
				response = await handlePropfind(env, owner, calPath, request); break;
			case 'REPORT':
				response = await handleReport(env, owner, calPath, request); break;
			case 'GET':
				response = await handleGet(env, calPath, uid); break;
			case 'PUT':
				response = await handlePut(env, calPath, uid, request); break;
			case 'DELETE':
				response = await handleDelete(env, calPath, uid); break;
			case 'MKCALENDAR':
				response = await handleMkcalendar(env, owner, calPath, request); break;
			default:
				response = new Response('Method Not Allowed', { status: 405, headers: { Allow: 'OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE, MKCALENDAR' } });
							}
						}
					}
				}
			}
			if (DEBUG && response) {
				const cloned = response.clone();
				const body = await cloned.text().catch(() => '(unreadable)');
				console.log(`Resp: ${response.status} ${body.substring(0, 800)}`);
			}
			return response;
		},
	};

// --- API handlers ---

async function handleApiRegister(env, request) {
	try {
		const { username, password, adminPassword } = await request.json();

		// Bootstrap: if no users exist, allow first registration without admin password
		const userCount = await env.CALDAV_DB.prepare('SELECT COUNT(*) as c FROM users').first();
		const isBootstrap = (userCount && userCount.c === 0);

		if (!isBootstrap) {
			if (!adminPassword) return jsonResponse({ error: 'adminPassword is required' }, 400);

			let adminOk = false;
			try {
				const adminUser = await authenticateUser(env.CALDAV_DB, 'admin', adminPassword);
				if (adminUser) adminOk = true;
			} catch (e) { /* ignore */ }
			if (!adminOk && env.AUTH_PASSWORD && adminPassword === env.AUTH_PASSWORD) {
				adminOk = true;
			}
			if (!adminOk) return jsonResponse({ error: 'Admin password incorrect' }, 403);
		}

		const result = await registerUser(env.CALDAV_DB, username, password);
		if (result.error) return jsonResponse({ error: result.error }, 400);
		return jsonResponse(result, 201);
	} catch (e) {
		return jsonResponse({ error: 'Invalid JSON body' }, 400);
	}
}

async function handleApiChangePassword(env, username, request) {
	try {
		const { oldPassword, newPassword } = await request.json();
		const result = await changePassword(env.CALDAV_DB, username, oldPassword, newPassword);
		if (result.error) return jsonResponse({ error: result.error }, 400);
		return jsonResponse(result);
	} catch (e) {
		return jsonResponse({ error: 'Invalid JSON body' }, 400);
	}
}

async function handleApiChangeUsername(env, oldUsername, request) {
	try {
		const { newUsername, password } = await request.json();
		const result = await changeUsername(env.CALDAV_DB, oldUsername, newUsername, password);
		if (result.error) return jsonResponse({ error: result.error }, 400);
		// New username means new calendar paths
		return jsonResponse({ success: true, username: result.username });
	} catch (e) {
		return jsonResponse({ error: 'Invalid JSON body' }, 400);
	}
}

async function handleApiDeleteUser(env, request) {
	try {
		const { username, adminPassword } = await request.json();
		if (!adminPassword) return jsonResponse({ error: 'adminPassword is required' }, 400);

		// Verify admin password
		let adminOk = false;
		try {
			const adminUser = await authenticateUser(env.CALDAV_DB, 'admin', adminPassword);
			if (adminUser) adminOk = true;
		} catch (e) { /* ignore */ }
		if (!adminOk && env.AUTH_PASSWORD === adminPassword) {
			adminOk = true;
		}
		if (!adminOk) return jsonResponse({ error: 'Admin password incorrect' }, 403);

		const result = await deleteUser(env.CALDAV_DB, username);
		if (result.error) return jsonResponse({ error: result.error }, 400);
		return jsonResponse(result);
	} catch (e) {
		return jsonResponse({ error: 'Invalid JSON body' }, 400);
	}
}

// --- CalDAV handlers ---

function handleOptions() {
	return new Response(null, {
		status: 200,
		headers: {
			...DAV_HEADERS,
			Allow: 'OPTIONS, PROPFIND, REPORT, GET, PUT, DELETE, MKCALENDAR',
		},
	});
}

function parsePropfindBody(text) {
	if (!text) return [];
	const props = [];
	const regex = /<(?:D:)?(getetag|getcontenttype|resourcetype|displayname|getctag|current-user-principal|calendar-home-set|supported-report-set|principal-URL|principal-collection-set|calendar-user-address-set|owner|sync-token|current-user-privilege-set)\s*\/?>/gi;
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
			const responses = buildCalendarResource(cal, []);
			return new Response(buildMultistatus(responses), { status: 207, headers: DAV_HEADERS });
		}

		const events = await listEvents(db, calPath, null, null);
		const responses = buildCalendarResource(cal, events);
		return new Response(buildMultistatus(responses), { status: 207, headers: DAV_HEADERS });
	}

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

	// sync-collection REPORT (RFC 6578)
	if (body.includes('sync-collection')) {
		return handleSyncCollection(cal, calPath, db);
	}

	// calendar-multiget REPORT (RFC 4791 §7.9)
	if (body.includes('calendar-multiget')) {
		return handleCalendarMultiget(calPath, db, body);
	}

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

async function handleSyncCollection(cal, calPath, db) {
	const events = await listEvents(db, calPath, null, null);
	const responses = buildEventList(calPath, events, true);
	const syncToken = `urn:caldav:sync:${cal.updated.replace(/[ :]/g, '_')}`;
	return new Response(buildMultistatus(responses, syncToken), { status: 207, headers: DAV_HEADERS });
}


async function handleCalendarMultiget(calPath, db, body) {
	// Extract hrefs from request body
	const hrefs = [];
	const hrefRegex = /<(?:D:)?href[^>]*>([^<]+)<\/(?:D:)?href>/g;
	let m;
	while ((m = hrefRegex.exec(body)) !== null) {
		hrefs.push(m[1]);
	}

	const responses = [];
	for (const href of hrefs) {
		// Extract UID from href: /admin/default/UID.ics
		const uid = href.split('/').pop()?.replace('.ics', '') || '';
		const event = await getEvent(db, calPath, uid);
		if (event) {
			responses.push({
				href,
				propstat: [{
					status: 'HTTP/1.1 200 OK',
					props: [
						{ ns: 'DAV:', name: 'getetag', value: `"${event.updated}"` },
						{ ns: CALDAV_NS, name: 'calendar-data', value: event.ics_data },
					],
				}],
			});
		} else {
			responses.push({
				href,
				propstat: [{ status: 'HTTP/1.1 404 Not Found', props: [] }],
			});
		}
	}
	return new Response(buildMultistatus(responses), { status: 207, headers: DAV_HEADERS });
}

async function handleGet(env, calPath, uid) {
	if (!calPath || !uid) return new Response('Not Found', { status: 404 });
	const event = await getEvent(env.CALDAV_DB, calPath, uid);
	if (!event) return new Response('Not Found', { status: 404 });
	return new Response(event.ics_data, {
		status: 200,
		headers: { 'Content-Type': 'text/calendar; charset=utf-8', ETag: `"${event.updated}"` },
	});
}

async function handlePut(env, calPath, uid, request) {
	if (!calPath || !uid) return new Response('Not Found', { status: 404 });
	const db = env.CALDAV_DB;
	const cal = await getCalendar(db, calPath);
	if (!cal) return new Response(buildError('not-found'), { status: 404, headers: DAV_HEADERS });

	const ifMatch = request.headers.get('If-Match');
	const ifNoneMatch = request.headers.get('If-None-Match');
	const existing = await getEvent(db, calPath, uid);

	if (ifMatch && existing) {
		if (existing.updated !== ifMatch.replace(/^"|"$/g, '')) {
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
	if (!dtstart) return new Response('Missing DTSTART', { status: 400 });

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
		return deleted ? new Response(null, { status: 204 }) : new Response('Not Found', { status: 404 });
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
	if (!calPath) return new Response('Bad Request', { status: 400 });
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
