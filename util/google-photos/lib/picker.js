const PICKER_API = 'https://photospicker.googleapis.com/v1';

async function apiFetch(client, url, options = {}) {
	const { token } = await client.getAccessToken();
	const res = await fetch(url, {
		...options,
		headers: {
			...options.headers,
			Authorization: `Bearer ${token}`,
		},
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Google Photos API error ${res.status} ${res.statusText}: ${body}`);
	}
	return res;
}

/** Creates a new picker session. Returns { id, pickerUri, pollingConfig, mediaItemsSet }. */
export async function createSession(client) {
	const res = await apiFetch(client, `${PICKER_API}/sessions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: '{}',
	});
	return res.json();
}

export async function getSession(client, sessionId) {
	const res = await apiFetch(client, `${PICKER_API}/sessions/${sessionId}`);
	return res.json();
}

export async function deleteSession(client, sessionId) {
	await apiFetch(client, `${PICKER_API}/sessions/${sessionId}`, { method: 'DELETE' });
}

export async function listMediaItems(client, sessionId) {
	const items = [];
	let pageToken;
	do {
		const url = new URL(`${PICKER_API}/mediaItems`);
		url.searchParams.set('sessionId', sessionId);
		url.searchParams.set('pageSize', '100');
		if (pageToken) url.searchParams.set('pageToken', pageToken);
		const res = await apiFetch(client, url.toString());
		const data = await res.json();
		items.push(...(data.mediaItems ?? []));
		pageToken = data.nextPageToken;
	} while (pageToken);
	return items;
}

function parseDurationMs(duration) {
	const match = /^([\d.]+)s$/.exec(duration ?? '');
	return match ? parseFloat(match[1]) * 1000 : null;
}

/** Polls a session until the user finishes picking, or throws after a safety timeout. */
export async function waitForSelection(client, session, { onPoll, maxWaitMs = 15 * 60 * 1000 } = {}) {
	let current = session;
	const start = Date.now();
	while (!current.mediaItemsSet) {
		if (Date.now() - start > maxWaitMs) {
			throw new Error('Timed out waiting for photo selection in Google Photos.');
		}
		const interval = parseDurationMs(current.pollingConfig?.pollInterval) ?? 3000;
		await new Promise((resolve) => setTimeout(resolve, interval));
		current = await getSession(client, session.id);
		onPoll?.(current);
	}
	return current;
}

/** Downloads the raw bytes of a picked media file, preserving metadata (per Google's `=d` download param). */
export async function downloadMediaFile(client, mediaFile) {
	const { token } = await client.getAccessToken();
	const res = await fetch(`${mediaFile.baseUrl}=d`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!res.ok) {
		throw new Error(`Failed to download ${mediaFile.filename}: ${res.status} ${res.statusText}`);
	}
	return Buffer.from(await res.arrayBuffer());
}
