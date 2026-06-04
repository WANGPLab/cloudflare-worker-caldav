// CalDAV Protocol Client for browser
// Communicates with CalDAV Worker backend via fetch + Basic Auth

const CalDAVClient = {
  // Build Basic Auth header
  _authHeader(username, password) {
    return 'Basic ' + btoa(username + ':' + password);
  },

  // Base fetch with auth
  async _fetch(url, options = {}) {
    const resp = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
      },
    });
    if (!resp.ok && resp.status !== 207) {
      const text = await resp.text().catch(() => '');
      throw new Error(`HTTP ${resp.status}: ${text.substring(0, 200)}`);
    }
    return resp;
  },

  // Test connection and discover principal
  async testConnection(serverUrl, username, password) {
    const auth = this._authHeader(username, password);
    const resp = await fetch(serverUrl, {
      method: 'OPTIONS',
      headers: { Authorization: auth },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(text || 'Connection failed');
    }
    return true;
  },

  // Discover calendars for a user
  async discoverCalendars(serverUrl, username, password) {
    const auth = this._authHeader(username, password);
    const resp = await fetch(serverUrl, {
      method: 'PROPFIND',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/xml',
        Depth: '1',
      },
    });

    const text = await resp.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    const responses = doc.querySelectorAll('response');

    const calendars = [];
    for (const r of responses) {
      const href = r.querySelector('href')?.textContent || '';
      // A calendar collection has resourcetype with calendar child
      const resourcetype = r.querySelector('resourcetype');
      if (resourcetype) {
        const calendar = resourcetype.querySelector('calendar');
        const collection = resourcetype.querySelector('collection');
        if (calendar || collection) {
          const name = r.querySelector('displayname')?.textContent || href;
          calendars.push({ href, name });
        }
      }
    }
    return calendars;
  },

  // Fetch events for a date range using calendar-query REPORT
  async fetchEvents(serverUrl, calendarPath, start, end, username, password) {
    const auth = this._authHeader(username, password);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${start}" end="${end}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

    const resp = await fetch(serverUrl + calendarPath, {
      method: 'REPORT',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/xml',
        Depth: '1',
      },
      body,
    });

    const text = await resp.text();
    const doc = (new DOMParser()).parseFromString(text, 'text/xml');
    const responses = doc.querySelectorAll('response');

    const events = [];
    for (const r of responses) {
      const href = r.querySelector('href')?.textContent || '';
      const calendarData = r.querySelector('calendar-data')?.textContent;
      const etag = r.querySelector('getetag')?.textContent || '';
      if (calendarData && calendarData.includes('BEGIN:VEVENT')) {
        const parsed = CalDAVClient._parseICS(calendarData, href, etag);
        if (parsed) events.push(parsed);
      }
    }
    return events;
  },

  // Create a new event
  async createEvent(serverUrl, calendarPath, uid, icsData, username, password) {
    const auth = this._authHeader(username, password);
    const url = serverUrl + calendarPath + uid + '.ics';
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: auth,
        'Content-Type': 'text/calendar; charset=utf-8',
        'If-None-Match': '*',
      },
      body: icsData,
    });
    return resp.ok || resp.status === 201 || resp.status === 204;
  },

  // Update an existing event
  async updateEvent(serverUrl, calendarPath, uid, icsData, etag, username, password) {
    const auth = this._authHeader(username, password);
    const url = serverUrl + calendarPath + uid + '.ics';
    const headers = {
      Authorization: auth,
      'Content-Type': 'text/calendar; charset=utf-8',
    };
    if (etag) headers['If-Match'] = etag;
    const resp = await fetch(url, { method: 'PUT', headers, body: icsData });
    return resp.ok || resp.status === 201 || resp.status === 204;
  },

  // Delete an event
  async deleteEvent(serverUrl, calendarPath, uid, username, password) {
    const auth = this._authHeader(username, password);
    const url = serverUrl + calendarPath + uid + '.ics';
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: auth },
    });
    return resp.ok || resp.status === 204;
  },

  // Simple ICS parser for VEVENT display
  _parseICS(icsText, href, etag) {
    const lines = icsText.split(/\r?\n/);
    const event = { href, etag };
    let inVevent = false;

    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') { inVevent = true; continue; }
      if (line === 'END:VEVENT') break;
      if (!inVevent) continue;

      const ci = line.indexOf(':');
      if (ci === -1) continue;
      const field = line.substring(0, ci);
      const semi = field.indexOf(';');
      const name = semi !== -1 ? field.substring(0, semi) : field;
      const value = line.substring(ci + 1);

      switch (name) {
        case 'UID': event.uid = value; break;
        case 'SUMMARY': event.title = value; break;
        case 'DESCRIPTION': event.description = value; break;
        case 'LOCATION': event.location = value; break;
        case 'DTSTART': event.start = CalDAVClient._parseDT(value, field); break;
        case 'DTEND': event.end = CalDAVClient._parseDT(value, field); break;
        case 'STATUS': event.status = value; break;
        case 'RRULE': event.rrule = value; break;
      }
    }
    if (!event.uid) event.uid = href.split('/').pop().replace('.ics', '');
    return event.uid ? event : null;
  },

  // Parse DTSTART/DTEND to ISO 8601 or Date
  _parseDT(value, field) {
    // DATE type: YYYYMMDD
    if (field.includes('VALUE=DATE')) {
      return value.substring(0, 4) + '-' + value.substring(4, 6) + '-' + value.substring(6, 8);
    }
    // DATE-TIME: YYYYMMDDTHHMMSS(Z)?
    const iso = value.substring(0, 4) + '-' + value.substring(4, 6) + '-' + value.substring(6, 8) +
      'T' + value.substring(9, 11) + ':' + value.substring(11, 13) + ':' + value.substring(13, 15);
    if (value.endsWith('Z')) return iso + 'Z';
    return iso; // local time
  },

  // Build ICS for a VEVENT
  buildICS(event) {
    const lines = [];
    lines.push('BEGIN:VCALENDAR');
    lines.push('VERSION:2.0');
    lines.push('PRODID:-//CalDAV Web//EN');
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + (event.uid || crypto.randomUUID()));
    lines.push('DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '') + 'Z');
    if (event.title) lines.push('SUMMARY:' + event.title);
    if (event.description) lines.push('DESCRIPTION:' + event.description.replace(/\n/g, '\\n'));
    if (event.location) lines.push('LOCATION:' + event.location);
    if (event.start) {
      if (event.allDay) {
        const d = event.start.substring(0, 10).replace(/-/g, '');
        lines.push('DTSTART;VALUE=DATE:' + d);
        if (event.end) {
          const e = event.end.substring(0, 10).replace(/-/g, '');
          lines.push('DTEND;VALUE=DATE:' + e);
        } else {
          lines.push('DTEND;VALUE=DATE:' + d);
        }
      } else {
        const s = event.start.replace(/[-:]/g, '');
        lines.push('DTSTART:' + s);
        if (event.end) lines.push('DTEND:' + event.end.replace(/[-:]/g, ''));
      }
    }
    if (event.rrule) lines.push('RRULE:' + event.rrule);
    lines.push('END:VEVENT');
    lines.push('END:VCALENDAR');
    return lines.join('\r\n') + '\r\n';
  },
};
