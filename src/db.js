// D1 database access layer for CalDAV operations

export async function getCalendar(db, path) {
	const result = await db.prepare('SELECT * FROM calendars WHERE path = ?').bind(path).first();
	return result || null;
}

export async function listCalendars(db, owner) {
	const result = await db.prepare('SELECT * FROM calendars WHERE owner = ?').bind(owner).all();
	return result.results;
}

export async function createCalendar(db, owner, path, name, description, color) {
	await db.prepare(
		`INSERT INTO calendars (owner, path, name, description, color, updated)
		 VALUES (?, ?, ?, ?, ?, datetime('now'))`
	).bind(owner, path, name, description || '', color || '#3366CC').run();
	return getCalendar(db, path);
}

export async function deleteCalendar(db, path) {
	await db.prepare('DELETE FROM calendars WHERE path = ?').bind(path).run();
}

export async function getEvent(db, calendarPath, uid) {
	const cal = await getCalendar(db, calendarPath);
	if (!cal) return null;
	const result = await db.prepare('SELECT * FROM events WHERE calendar_id = ? AND uid = ?')
		.bind(cal.id, uid).first();
	return result || null;
}

export async function listEvents(db, calendarPath, start, end) {
	const cal = await getCalendar(db, calendarPath);
	if (!cal) return [];
	let result;
	if (start && end) {
		result = await db.prepare(
			`SELECT * FROM events WHERE calendar_id = ? AND dtstart < ? AND dtend > ? ORDER BY dtstart`
		).bind(cal.id, end, start).all();
	} else {
		result = await db.prepare(
			'SELECT * FROM events WHERE calendar_id = ? ORDER BY dtstart'
		).bind(cal.id).all();
	}
	return result.results;
}

export async function upsertEvent(db, calendarPath, uid, icsData, dtstart, dtend) {
	console.log(`[upsertEvent] calendarPath="${calendarPath}" uid="${uid}"`);
	const cal = await getCalendar(db, calendarPath);
	if (!cal) { console.log(`[upsertEvent] calendar NOT found`); return null; }
	console.log(`[upsertEvent] cal.id=${cal.id}`);
	const existing = await db.prepare(
		'SELECT id FROM events WHERE calendar_id = ? AND uid = ?'
	).bind(cal.id, uid).first();

	if (existing) {
		console.log(`[upsertEvent] UPDATE id=${existing.id}`);
		await db.prepare(
			`UPDATE events SET ics_data = ?, dtstart = ?, dtend = ?, updated = datetime('now')
			 WHERE id = ?`
		).bind(icsData, dtstart, dtend, existing.id).run();
	} else {
		console.log(`[upsertEvent] INSERT`);
		await db.prepare(
			`INSERT INTO events (calendar_id, uid, ics_data, dtstart, dtend)
			 VALUES (?, ?, ?, ?, ?)`
		).bind(cal.id, uid, icsData, dtstart, dtend).run();
	}
	await db.prepare(`UPDATE calendars SET updated = datetime('now') WHERE id = ?`).bind(cal.id).run();
	const verify = await getEvent(db, calendarPath, uid);
	console.log(`[upsertEvent] verify: ${verify ? 'FOUND' : 'NOT FOUND'}`);
	return verify;
}

export async function deleteEvent(db, calendarPath, uid) {
	console.log(`[deleteEvent] calendarPath="${calendarPath}" uid="${uid}"`);
	const cal = await getCalendar(db, calendarPath);
	if (!cal) { console.log(`[deleteEvent] calendar NOT found`); return false; }
	console.log(`[deleteEvent] cal.id=${cal.id}`);
	const check = await db.prepare('SELECT id, uid FROM events WHERE calendar_id = ? AND uid = ?')
		.bind(cal.id, uid).first();
	console.log(`[deleteEvent] check: ${check ? `id=${check.id} uid="${check.uid}"` : 'NOT FOUND'}`);
	const result = await db.prepare(
		'DELETE FROM events WHERE calendar_id = ? AND uid = ?'
	).bind(cal.id, uid).run();
	console.log(`[deleteEvent] changes=${result.meta.changes}`);
	if (result.meta.changes > 0) {
		await db.prepare(`UPDATE calendars SET updated = datetime('now') WHERE id = ?`).bind(cal.id).run();
		return true;
	}
	return false;
}
