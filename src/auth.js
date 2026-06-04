// HTTP Basic Auth for CalDAV
// Checks D1 users table first, falls back to env vars
import { DAV_HEADERS } from './xml';
import { authenticateUser } from './users';

// Returns { username } on success, null on failure
export async function authenticate(request, env) {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Basic ')) {
		// If env vars are not set either, allow open access
		if (!env.AUTH_USERNAME && !env.AUTH_PASSWORD) return { username: 'anonymous' };
		return null;
	}

	const encoded = authHeader.substring(6);
	let username, password;
	try {
		const decoded = atob(encoded);
		const colonIdx = decoded.indexOf(':');
		if (colonIdx === -1) return null;
		username = decoded.substring(0, colonIdx);
		password = decoded.substring(colonIdx + 1);
	} catch {
		return null;
	}

	// 1) Try D1 users table
	try {
		const user = await authenticateUser(env.CALDAV_DB, username, password);
		if (user) return { username: user.username };
	} catch (e) {
		// D1 query failed, fall through to env vars
	}

	// 2) Fall back to env vars (backwards compatibility)
	if (env.AUTH_USERNAME && env.AUTH_PASSWORD) {
		if (username === env.AUTH_USERNAME && password === env.AUTH_PASSWORD) {
			return { username };
		}
	}

	return null;
}

export function authChallengeResponse() {
	return new Response('Unauthorized', {
		status: 401,
		headers: {
			'WWW-Authenticate': 'Basic realm="CalDAV"',
			...DAV_HEADERS,
		},
	});
}
