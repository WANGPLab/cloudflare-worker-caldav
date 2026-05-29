import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

const OWNER = 'testuser';
const CAL_NAME = 'default';
const CAL_PATH = `/${OWNER}/${CAL_NAME}/`;

// Use SELF.fetch for all CalDAV tests since WebDAV methods (PROPFIND, REPORT,
// MKCALENDAR) aren't valid for the standard Request constructor.

function makeIcs(uid, summary, start, end) {
	return [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//Test//EN',
		'BEGIN:VEVENT',
		`UID:${uid}`,
		`SUMMARY:${summary}`,
		`DTSTART:${start}`,
		`DTEND:${end}`,
		'END:VEVENT',
		'END:VCALENDAR',
	].join('\r\n') + '\r\n';
}

async function seedCalendar() {
	await SELF.fetch(`http://localhost${CAL_PATH}`, { method: 'MKCALENDAR' });
	await SELF.fetch(`http://localhost${CAL_PATH}evt-1.ics`, { method: 'PUT', body: makeIcs('evt-1', 'Meeting', '20260529T100000Z', '20260529T110000Z') });
	await SELF.fetch(`http://localhost${CAL_PATH}evt-2.ics`, { method: 'PUT', body: makeIcs('evt-2', 'Lunch', '20260529T120000Z', '20260529T130000Z') });
	await SELF.fetch(`http://localhost${CAL_PATH}evt-3.ics`, { method: 'PUT', body: makeIcs('evt-3', 'Gym', '20260530T080000Z', '20260530T090000Z') });
}

describe('CalDAV Worker', () => {
	beforeAll(async () => {
		await seedCalendar();
	});

	describe('OPTIONS', () => {
		it('returns DAV headers and allowed methods', async () => {
			const resp = await SELF.fetch('http://localhost/', { method: 'OPTIONS' });
			expect(resp.status).toBe(200);
			expect(resp.headers.get('DAV')).toContain('calendar-access');
			expect(resp.headers.get('Allow')).toContain('PROPFIND');
			expect(resp.headers.get('Allow')).toContain('REPORT');
			expect(resp.headers.get('Allow')).toContain('MKCALENDAR');
		});
	});

	describe('MKCALENDAR', () => {
		it('creates a new calendar', async () => {
			const resp = await SELF.fetch('http://localhost/testuser/work/', { method: 'MKCALENDAR' });
			expect(resp.status).toBe(201);
		});

		it('returns 409 for duplicate calendar', async () => {
			const resp = await SELF.fetch('http://localhost/testuser/work/', { method: 'MKCALENDAR' });
			expect(resp.status).toBe(409);
		});
	});

	describe('PROPFIND', () => {
		it('lists calendars for a user', async () => {
			const resp = await SELF.fetch(`http://localhost/${OWNER}/`, {
				method: 'PROPFIND',
				headers: { Depth: '1' },
			});
			expect(resp.status).toBe(207);
			const text = await resp.text();
			expect(text).toContain('<D:multistatus');
			expect(text).toContain(CAL_PATH);
		});

		it('lists events in a calendar', async () => {
			const resp = await SELF.fetch(`http://localhost${CAL_PATH}`, { method: 'PROPFIND' });
			expect(resp.status).toBe(207);
			const text = await resp.text();
			expect(text).toContain('evt-1');
			expect(text).toContain('evt-2');
		});
	});

	describe('REPORT calendar-query', () => {
		it('filters events by time range', async () => {
			const reportBody = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="20260529T000000Z" end="20260530T000000Z"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;
			const resp = await SELF.fetch(`http://localhost${CAL_PATH}`, {
				method: 'REPORT',
				body: reportBody,
			});
			expect(resp.status).toBe(207);
			const text = await resp.text();
			expect(text).toContain('evt-1');
			expect(text).toContain('evt-2');
			expect(text).not.toContain('evt-3');
		});
	});

	describe('GET event', () => {
		it('retrieves an event by UID', async () => {
			const resp = await SELF.fetch(`http://localhost${CAL_PATH}evt-1.ics`);
			expect(resp.status).toBe(200);
			const text = await resp.text();
			expect(text).toContain('Meeting');
			expect(text).toContain('DTSTART:20260529T100000Z');
		});

		it('returns 404 for unknown event', async () => {
			const resp = await SELF.fetch(`http://localhost${CAL_PATH}nonexistent.ics`);
			expect(resp.status).toBe(404);
		});
	});

	describe('PUT event', () => {
		it('creates a new event', async () => {
			const ics = makeIcs('evt-new', 'New Task', '20260601T140000Z', '20260601T150000Z');
			const resp = await SELF.fetch(`http://localhost${CAL_PATH}evt-new.ics`, {
				method: 'PUT',
				body: ics,
				headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
			});
			expect(resp.status).toBe(201);
		});

		it('updates an existing event', async () => {
			const ics = makeIcs('evt-1', 'Updated Meeting', '20260529T100000Z', '20260529T113000Z');
			const resp = await SELF.fetch(`http://localhost${CAL_PATH}evt-1.ics`, {
				method: 'PUT',
				body: ics,
				headers: { 'Content-Type': 'text/calendar; charset=utf-8' },
			});
			expect(resp.status).toBe(204);
		});
	});

	describe('DELETE', () => {
		it('deletes an event', async () => {
			// Create first
			await SELF.fetch(`http://localhost${CAL_PATH}evt-del.ics`, {
				method: 'PUT',
				body: makeIcs('evt-del', 'Temp', '20260602T100000Z', '20260602T110000Z'),
			});
			const resp = await SELF.fetch(`http://localhost${CAL_PATH}evt-del.ics`, { method: 'DELETE' });
			expect(resp.status).toBe(204);

			const getResp = await SELF.fetch(`http://localhost${CAL_PATH}evt-del.ics`);
			expect(getResp.status).toBe(404);
		});

		it('deletes a calendar', async () => {
			await SELF.fetch('http://localhost/testuser/tempcal/', { method: 'MKCALENDAR' });
			const resp = await SELF.fetch('http://localhost/testuser/tempcal/', { method: 'DELETE' });
			expect(resp.status).toBe(204);
		});
	});

	describe('unit style', () => {
		it('GET event works with worker.fetch', async () => {
			const request = new Request(`http://localhost${CAL_PATH}evt-1.ics`);
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(response.status).toBe(200);
			const text = await response.text();
			expect(text).toContain('Meeting');
		});
	});
});
