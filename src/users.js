// User management with PBKDF2 password hashing via Web Crypto API

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

// Generate PBKDF2 hash: salt + ":" + hash_hex
async function hashPassword(password) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const key = await crypto.subtle.importKey('raw', ENCODER.encode(password), 'PBKDF2', false, ['deriveBits']);
	const hash = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
		key,
		256
	);
	return bytesToHex(salt) + ':' + bytesToHex(new Uint8Array(hash));
}

// Verify password against stored hash
async function verifyPassword(password, stored) {
	const colonIdx = stored.indexOf(':');
	if (colonIdx === -1) return false;
	const salt = hexToBytes(stored.substring(0, colonIdx));
	const expectedHash = stored.substring(colonIdx + 1);
	const key = await crypto.subtle.importKey('raw', ENCODER.encode(password), 'PBKDF2', false, ['deriveBits']);
	const hash = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
		key,
		256
	);
	return bytesToHex(new Uint8Array(hash)) === expectedHash;
}

export async function registerUser(db, username, password) {
	if (!username || !password) return { error: 'Username and password required' };
	if (username.length < 2 || username.length > 32) return { error: 'Username must be 2-32 characters' };
	if (password.length < 4) return { error: 'Password must be at least 4 characters' };
	if (!/^[a-zA-Z0-9_-]+$/.test(username)) return { error: 'Username: only letters, numbers, -, _' };

	const existing = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
	if (existing) return { error: 'Username already taken' };

	const hash = await hashPassword(password);
	await db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').bind(username, hash).run();

	// Auto-create default calendar for the new user
	await db.prepare(
		`INSERT INTO calendars (owner, path, name, description, color)
		 VALUES (?, ?, 'Default', 'Default calendar', '#3366CC')`
	).bind(username, '/' + username + '/default/').run();

	return { success: true, username };
}

export async function deleteUser(db, usernameToDelete) {
	const user = await db.prepare('SELECT id FROM users WHERE username = ?').bind(usernameToDelete).first();
	if (!user) return { error: 'User not found' };
	if (usernameToDelete === 'admin') return { error: 'Cannot delete admin' };

	await db.prepare('DELETE FROM events WHERE calendar_id IN (SELECT id FROM calendars WHERE owner = ?)').bind(usernameToDelete).run();
	await db.prepare('DELETE FROM calendars WHERE owner = ?').bind(usernameToDelete).run();
	await db.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
	return { success: true, username: usernameToDelete };
}

export async function authenticateUser(db, username, password) {
	const user = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
	if (!user) return null;
	const ok = await verifyPassword(password, user.password_hash);
	return ok ? user : null;
}

export async function changePassword(db, username, oldPassword, newPassword) {
	const user = await authenticateUser(db, username, oldPassword);
	if (!user) return { error: 'Current password is incorrect' };
	if (!newPassword || newPassword.length < 4) return { error: 'New password must be at least 4 characters' };

	const hash = await hashPassword(newPassword);
	await db.prepare('UPDATE users SET password_hash = ?, updated = datetime(\'now\') WHERE id = ?')
		.bind(hash, user.id).run();
	return { success: true };
}

export async function changeUsername(db, oldUsername, newUsername, password) {
	const user = await authenticateUser(db, oldUsername, password);
	if (!user) return { error: 'Password incorrect' };
	if (!newUsername || newUsername.length < 2 || newUsername.length > 32) return { error: 'Username must be 2-32 characters' };
	if (!/^[a-zA-Z0-9_-]+$/.test(newUsername)) return { error: 'Username: only letters, numbers, -, _' };

	const existing = await db.prepare('SELECT id FROM users WHERE username = ?').bind(newUsername).first();
	if (existing) return { error: 'Username already taken' };

	await db.prepare('UPDATE users SET username = ?, updated = datetime(\'now\') WHERE id = ?')
		.bind(newUsername, user.id).run();

	// Update calendar owner references
	await db.prepare("UPDATE calendars SET owner = ?, path = REPLACE(path, '/'||?||'/','/'||?||'/'), updated = datetime('now') WHERE owner = ?")
		.bind(newUsername, oldUsername, newUsername, oldUsername).run();

	return { success: true, username: newUsername };
}

function bytesToHex(bytes) {
	return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes;
}
