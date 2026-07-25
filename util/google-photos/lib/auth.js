import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAuth2Client } from 'google-auth-library';
import open from 'open';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CREDENTIALS_PATH = path.join(__dirname, '..', 'credentials.json');
const TOKEN_PATH = path.join(__dirname, '..', 'token.json');

const SCOPES = ['https://www.googleapis.com/auth/photospicker.mediaitems.readonly'];

function loadCredentials() {
	if (!fs.existsSync(CREDENTIALS_PATH)) {
		throw new Error(
			`Missing ${CREDENTIALS_PATH}\n\n` +
				'Create a Google Cloud OAuth "Desktop app" client (see util/google-photos/README.md), ' +
				'download its JSON, and save it at that path.'
		);
	}
	const raw = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
	const creds = raw.installed ?? raw.web ?? raw;
	if (!creds.client_id || !creds.client_secret) {
		throw new Error(`${CREDENTIALS_PATH} is missing client_id/client_secret.`);
	}
	return creds;
}

function loadSavedToken() {
	if (!fs.existsSync(TOKEN_PATH)) return null;
	try {
		return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
	} catch {
		return null;
	}
}

function saveToken(tokens) {
	const merged = { ...loadSavedToken(), ...tokens };
	fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
}

function runLoopbackAuthFlow(oAuth2Client) {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			handleRequest(req, res).catch(reject);
		});

		async function handleRequest(req, res) {
			const port = server.address().port;
			const redirectUri = `http://127.0.0.1:${port}`;
			const requestUrl = new URL(req.url, redirectUri);
			if (requestUrl.pathname !== '/') {
				res.writeHead(404).end();
				return;
			}

			const error = requestUrl.searchParams.get('error');
			const code = requestUrl.searchParams.get('code');
			res.writeHead(200, { 'Content-Type': 'text/html' });
			if (error || !code) {
				res.end('<html><body>Authorization failed. You can close this window.</body></html>');
				server.close();
				reject(new Error(`Google OAuth authorization failed: ${error ?? 'no code returned'}`));
				return;
			}

			const { tokens } = await oAuth2Client.getToken({ code, redirect_uri: redirectUri });
			oAuth2Client.setCredentials(tokens);
			saveToken(tokens);
			res.end('<html><body>Authorized! You can close this window and return to the terminal.</body></html>');
			server.close();
			resolve(oAuth2Client);
		}

		server.on('error', reject);

		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			const redirectUri = `http://127.0.0.1:${port}`;
			const authUrl = oAuth2Client.generateAuthUrl({
				access_type: 'offline',
				prompt: 'consent',
				scope: SCOPES,
				redirect_uri: redirectUri,
			});
			console.log('\nOpening your browser to authorize access to Google Photos...');
			console.log(`If it does not open automatically, visit this URL:\n${authUrl}\n`);
			open(authUrl).catch(() => {});
		});
	});
}

/** Returns an OAuth2Client authorized for the Google Photos Picker API, reusing a saved token when possible. */
export async function getAuthorizedClient() {
	const { client_id, client_secret } = loadCredentials();
	const oAuth2Client = new OAuth2Client({ clientId: client_id, clientSecret: client_secret });
	oAuth2Client.on('tokens', (tokens) => saveToken(tokens));

	const savedToken = loadSavedToken();
	if (savedToken?.refresh_token) {
		oAuth2Client.setCredentials(savedToken);
		try {
			await oAuth2Client.getAccessToken();
			return oAuth2Client;
		} catch {
			console.warn('Saved Google Photos token expired or was revoked; re-authorizing...');
		}
	}

	return runLoopbackAuthFlow(oAuth2Client);
}
