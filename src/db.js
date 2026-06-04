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
			`SELECT * FROM events WHERE calendar_id = ? AND (dtstart < ? AND dtend > ? OR ics_data LIKE '%RRULE%' OR ics_data LIKE '%RDATE%') ORDER BY dtstart`
		).bind(cal.id, end, start).all();
	} else {
		result = await db.prepare(
			'SELECT * FROM events WHERE calendar_id = ? ORDER BY dtstart'
		).bind(cal.id).all();
	}
	return result.results;
}

export async function upsertEvent(db, calendarPath, uid, icsData, dtstart, dtend) {
	const cal = await getCalendar(db, calendarPath);
	if (!cal) return null;
	const existing = await db.prepare(
		'SELECT id FROM events WHERE calendar_id = ? AND uid = ?'
	).bind(cal.id, uid).first();

	if (existing) {
		await db.prepare(
			`UPDATE events SET ics_data = ?, dtstart = ?, dtend = ?, updated = datetime('now')
			 WHERE id = ?`
		).bind(icsData, dtstart, dtend, existing.id).run();
	} else {
		await db.prepare(
			`INSERT INTO events (calendar_id, uid, ics_data, dtstart, dtend)
			 VALUES (?, ?, ?, ?, ?)`
		).bind(cal.id, uid, icsData, dtstart, dtend).run();
	}
	// Update calendar ctag so clients detect changes
	await db.prepare(`UPDATE calendars SET updated = datetime('now') WHERE id = ?`).bind(cal.id).run();
	return getEvent(db, calendarPath, uid);
}

export async function deleteEvent(db, calendarPath, uid) {
	const cal = await getCalendar(db, calendarPath);
	if (!cal) return false;
	const result = await db.prepare(
		'DELETE FROM events WHERE calendar_id = ? AND uid = ?'
	).bind(cal.id, uid).run();
	if (result.changes > 0) {
		await db.prepare(`UPDATE calendars SET updated = datetime('now') WHERE id = ?`).bind(cal.id).run();
		return true;
	}
	return false;
}
