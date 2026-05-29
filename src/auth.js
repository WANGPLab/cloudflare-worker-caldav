// HTTP Basic Auth for CalDAV

export function authenticate(request, env) {
	// If no credentials configured, allow all access
	if (!env.AUTH_USERNAME || !env.AUTH_PASSWORD) {
		return true;
	}

	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Basic ')) {
		return false;
	}

	const encoded = authHeader.substring(6);
	try {
		const decoded = atob(encoded);
		const colonIdx = decoded.indexOf(':');
		if (colonIdx === -1) return false;
		const username = decoded.substring(0, colonIdx);
		const password = decoded.substring(colonIdx + 1);
		return username === env.AUTH_USERNAME && password === env.AUTH_PASSWORD;
	} catch {
		return false;
	}
}

export function authChallengeResponse() {
	return new Response('Unauthorized', {
		status: 401,
		headers: {
			'WWW-Authenticate': 'Basic realm="CalDAV"',
		},
	});
}
