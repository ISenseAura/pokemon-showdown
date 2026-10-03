/**
 * Local TCG replay files. Playback is TcgBoard on the client host, not replay.pokemonshowdown.com.
 *
 * GET /replay/{id}.json  (also /replays/{id}.json)
 * Share URL: https://{client}/battle-{id}
 */
import * as http from 'http';
import * as path from 'path';
import { FS, crashlogger } from '../lib';

export type TcgReplayRow = {
	id: string,
	format: string,
	players: string[],
	log: string,
	uploadtime: number,
	private: number,
	password: string | null,
	rating?: number | null,
};

function logsDir() {
	const base = Config.logsdir || 'logs';
	return path.join(base, 'replays');
}

function indexFile() {
	const base = Config.logsdir || 'logs';
	return FS(path.join(base, 'replay-index.json'));
}

export type TcgReplayIndexRow = {
	id: string,
	format: string,
	players: string[],
	uploadtime: number,
	rating: number | null,
	private: number,
};

const REPLAY_PAGE = 50;

export function sanitizeReplayId(id: string) {
	return String(id || '').toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 80);
}

export function parseReplayId(raw: string): { id: string, password: string | null } {
	let name = String(raw || '');
	if (name.endsWith('.json')) name = name.slice(0, -5);
	name = sanitizeReplayId(name);
	if (name.endsWith('pw')) {
		const end = name.length - 2;
		const lastHyphen = name.lastIndexOf('-', end);
		if (lastHyphen > 0) {
			return { id: name.slice(0, lastHyphen), password: name.slice(lastHyphen + 1, end) };
		}
	}
	return { id: name, password: null };
}

export function realPassword(password: unknown): string | null {
	if (typeof password !== 'string') return null;
	if (!password || password === 'null' || password === 'undefined') return null;
	return password;
}

export function tcgClientHost(): string {
	const host = Config.routes?.client;
	if (host && host !== 'play.pokemonshowdown.com' && host !== 'replay.pokemonshowdown.com') {
		return host;
	}
	return 'ptcg.pnine.me';
}

export function tcgReplayShareUrl(id: string, password?: string | null) {
	const pw = realPassword(password);
	const suffix = pw ? `-${pw}pw` : '';
	return `https://${tcgClientHost()}/battle-${sanitizeReplayId(id)}${suffix}`;
}

export function replayFile(id: string) {
	return FS(path.join(logsDir(), `${sanitizeReplayId(id)}.json`));
}

export async function saveTcgReplay(row: TcgReplayRow): Promise<string> {
	const id = sanitizeReplayId(row.id);
	const password = realPassword(row.password);
	const stored: TcgReplayRow = { ...row, id, password };
	await FS(logsDir()).mkdirp();
	await replayFile(id).write(JSON.stringify(stored));
	await rememberReplay(stored);
	return password ? `${id}-${password}pw` : id;
}

function indexRow(row: TcgReplayRow): TcgReplayIndexRow {
	return {
		id: sanitizeReplayId(row.id),
		format: String(row.format || ''),
		players: Array.isArray(row.players) ? row.players.map(name => String(name)) : [],
		uploadtime: Number(row.uploadtime) || 0,
		rating: row.rating ? Number(row.rating) : null,
		private: Number(row.private) || 0,
	};
}

async function readIndex(): Promise<TcgReplayIndexRow[] | null> {
	const file = indexFile();
	if (!await file.exists()) return null;
	try {
		const rows = JSON.parse(await file.read('utf8'));
		return Array.isArray(rows) ? rows : null;
	} catch {
		return null;
	}
}

async function writeIndex(rows: TcgReplayIndexRow[]) {
	const base = Config.logsdir || 'logs';
	await FS(base).mkdirp();
	await indexFile().write(JSON.stringify(rows));
}

async function rebuildIndex(): Promise<TcgReplayIndexRow[]> {
	const names = await FS(logsDir()).readdirIfExists();
	const rows: TcgReplayIndexRow[] = [];
	for (const name of names) {
		if (!name.endsWith('.json')) continue;
		try {
			const row = JSON.parse(await FS(path.join(logsDir(), name)).read('utf8')) as TcgReplayRow;
			if (!row?.id || !row.log) continue;
			rows.push(indexRow(row));
		} catch {
			// A bad file should not hide the rest of the catalog.
		}
	}
	await writeIndex(rows);
	return rows;
}

async function rememberReplay(row: TcgReplayRow) {
	const next = indexRow(row);
	const rows = await readIndex() || await rebuildIndex();
	const at = rows.findIndex(item => item.id === next.id);
	if (at >= 0) rows[at] = next;
	else rows.push(next);
	await writeIndex(rows);
}

function isListed(row: TcgReplayIndexRow) {
	return row.private === 0 || row.private === 10;
}

/** Socket workers do not load the sim, so this cannot call the global `toID`. */
function replayId(name: string) {
	return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export async function listTcgReplays(query: {
	username?: string,
	format?: string,
	page?: number,
	sort?: string,
}): Promise<TcgReplayIndexRow[]> {
	const rows = (await readIndex() || await rebuildIndex()).filter(isListed);
	const names = String(query.username || '').split(',').map(replayId).filter(Boolean);
	const format = replayId(query.format || '');
	const matched = rows.filter(row => {
		if (names.length) {
			const players = row.players.map(replayId);
			if (!names.every(name => players.includes(name))) return false;
		}
		if (format && !replayId(row.format).includes(format)) return false;
		return true;
	});
	if (query.sort === 'rating') {
		matched.sort((a, b) => (b.rating || 0) - (a.rating || 0) || b.uploadtime - a.uploadtime);
	} else {
		matched.sort((a, b) => b.uploadtime - a.uploadtime);
	}
	const page = Math.max(1, Math.floor(Number(query.page) || 1));
	const start = (page - 1) * REPLAY_PAGE;
	return matched.slice(start, start + REPLAY_PAGE + 1);
}

export async function readTcgReplay(id: string, password: string | null): Promise<TcgReplayRow | null> {
	const file = replayFile(id);
	if (!await file.exists()) return null;
	try {
		const row = JSON.parse(await file.read('utf8')) as TcgReplayRow;
		const need = realPassword(row.password);
		if (need && need !== realPassword(password)) return null;
		return row;
	} catch {
		return null;
	}
}

function corsHeaders(req: http.IncomingMessage) {
	const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
	const client = `https://${tcgClientHost()}`;
	const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
	return {
		'Access-Control-Allow-Origin': origin === client || local ? origin : client,
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Vary': 'Origin',
		'Cache-Control': 'public, max-age=60',
		'Content-Type': 'application/json; charset=utf-8',
	};
}

function queryOf(req: http.IncomingMessage) {
	const raw = (req.url || '').split('?')[1] || '';
	const out: { [k: string]: string } = {};
	for (const part of raw.split('&')) {
		if (!part) continue;
		const eq = part.indexOf('=');
		const key = decodeURIComponent(eq >= 0 ? part.slice(0, eq) : part);
		const value = decodeURIComponent((eq >= 0 ? part.slice(eq + 1) : '').replace(/\+/g, ' '));
		out[key] = value;
	}
	return out;
}

function escapeHtml(text: string) {
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function replayWhen(uploadtime: number) {
	if (!uploadtime) return '';
	const d = new Date(uploadtime * 1000);
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function publicReplay(row: TcgReplayIndexRow) {
	return {
		id: row.id,
		format: row.format,
		players: row.players,
		uploadtime: row.uploadtime,
		rating: row.rating || undefined,
	};
}

function renderReplayBrowser(rows: TcgReplayIndexRow[], query: { [k: string]: string }) {
	const user = query.user || query.username || '';
	const format = query.format || '';
	const page = Math.max(1, Math.floor(Number(query.page) || 1));
	const sort = query.sort === 'rating' ? 'rating' : '';
	const more = rows.length > REPLAY_PAGE;
	const shown = more ? rows.slice(0, REPLAY_PAGE) : rows;
	const searching = !!(user || format);
	const links = shown.map(row => {
		const href = escapeHtml(tcgReplayShareUrl(row.id));
		const rating = row.rating ? ` (Rating: ${row.rating})` : '';
		const when = replayWhen(row.uploadtime);
		const players = row.players.map(name => `<strong>${escapeHtml(name)}</strong>`).join(' vs. ');
		return `<li><a class="blocklink" href="${href}"><small>${escapeHtml(row.format)}${rating}` +
			`${when ? `<br />${when}` : ''}</small><br />${players || 'Unknown players'}</a></li>`;
	}).join('');
	const empty = shown.length ? '' : '<li><em>No replays found.</em></li>';
	const pageQuery = (next: number, nextSort = sort) => {
		const parts = [];
		if (user) parts.push(`user=${encodeURIComponent(user)}`);
		if (format) parts.push(`format=${encodeURIComponent(format)}`);
		if (next > 1) parts.push(`page=${next}`);
		if (nextSort) parts.push(`sort=${nextSort}`);
		return '/replays' + (parts.length ? `?${parts.join('&')}` : '');
	};
	return `<!DOCTYPE html>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width" />
<title>Replays</title>
<style>
	body { margin: 0; background: #f6f6f6; color: #222; font: 11pt Verdana, sans-serif; }
	.wrap { max-width: 640px; margin: 0 auto; padding: 16px; }
	h1 { font-size: 16pt; margin: 0 0 12px; }
	label { display: block; margin: 0 0 10px; }
	input[type=search] { width: 100%; max-width: 280px; box-sizing: border-box; padding: 4px 6px; }
	.button { display: inline-block; padding: 4px 10px; border: 1px solid #888; border-radius: 4px; background: #fff; color: #222; text-decoration: none; }
	.linklist { list-style: none; margin: 12px 0; padding: 0; }
	.blocklink { display: block; margin: 0 0 8px; padding: 8px 10px; background: #fff; border: 1px solid #ddd; border-radius: 6px; color: #1258a7; text-decoration: none; }
	.blocklink small { color: #666; }
	.blocklink strong { color: #222; }
	.pages { margin-top: 8px; }
</style>
<div class="wrap">
	<h1>${searching ? 'Search replays' : 'Recent replays'}</h1>
	<form method="get" action="/replays">
		<label>Username <small>(separate multiple with commas)</small><br />
			<input type="search" name="user" value="${escapeHtml(user)}" placeholder="(blank = any user)" />
		</label>
		<label>Format<br />
			<input type="search" name="format" value="${escapeHtml(format)}" placeholder="(blank = any format)" />
		</label>
		<button class="button" type="submit">Search</button>
		${searching ? `<a class="button" href="/replays">Cancel</a>` : ''}
	</form>
	${searching && format && !user ? `<p>Sort by <a href="${pageQuery(1, '')}">Date</a> · <a href="${pageQuery(1, 'rating')}">Rating</a></p>` : ''}
	${page > 1 ? `<p class="pages"><a class="button" href="${pageQuery(page - 1)}">Page ${page - 1}</a></p>` : ''}
	<ul class="linklist">${links}${empty}</ul>
	${more ? `<p class="pages"><a class="button" href="${pageQuery(page + 1)}">Page ${page + 1}</a></p>` : ''}
</div>`;
}

/** SockJS HTTP: GET /replays, /replays/search.json, and /replay/{id}.json */
export function serveTcgReplayHttp(req: http.IncomingMessage, res: http.ServerResponse): boolean {
	const pathOnly = (req.url || '').split('?')[0];
	if (pathOnly === '/replays' || pathOnly === '/replays/' || pathOnly === '/replay' || pathOnly === '/replay/') {
		if (req.method === 'OPTIONS') {
			res.writeHead(204, corsHeaders(req));
			res.end();
			return true;
		}
		if (req.method !== 'GET' && req.method !== 'HEAD') return false;
		const query = queryOf(req);
		void listTcgReplays({
			username: query.user || query.username,
			format: query.format,
			page: Number(query.page) || 1,
			sort: query.sort,
		}).then(rows => {
			const html = renderReplayBrowser(rows, query);
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			if (req.method === 'HEAD') res.end();
			else res.end(html);
		}).catch((err: any) => {
			crashlogger(err, 'TCG replay list');
			if (!res.headersSent) {
				res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end('replay list failed');
			}
		});
		return true;
	}
	if (pathOnly === '/replays/search.json' || pathOnly === '/replay/search.json') {
		if (req.method === 'OPTIONS') {
			res.writeHead(204, corsHeaders(req));
			res.end();
			return true;
		}
		if (req.method !== 'GET' && req.method !== 'HEAD') return false;
		const query = queryOf(req);
		void listTcgReplays({
			username: query.username || query.user,
			format: query.format,
			page: Number(query.page) || 1,
			sort: query.sort,
		}).then(rows => {
			res.writeHead(200, corsHeaders(req));
			if (req.method === 'HEAD') {
				res.end();
				return;
			}
			res.end(JSON.stringify(rows.map(publicReplay)));
		}).catch((err: any) => {
			crashlogger(err, 'TCG replay list');
			if (!res.headersSent) {
				res.writeHead(500, corsHeaders(req));
				res.end('{"error":"replay list failed"}');
			}
		});
		return true;
	}
	const m = /^\/replays?\/([a-z0-9.-]+)$/i.exec(pathOnly);
	if (!m) return false;
	if (req.method === 'OPTIONS') {
		res.writeHead(204, corsHeaders(req));
		res.end();
		return true;
	}
	if (req.method !== 'GET' && req.method !== 'HEAD') return false;
	const { id, password } = parseReplayId(m[1]);
	if (!id) {
		res.writeHead(404, corsHeaders(req));
		res.end('{"error":"not found"}');
		return true;
	}
	void readTcgReplay(id, password).then(row => {
		if (!row) {
			res.writeHead(404, corsHeaders(req));
			res.end('{"error":"not found"}');
			return;
		}
		const body = JSON.stringify({
			id: row.id,
			format: row.format,
			players: row.players,
			log: row.log,
			uploadtime: row.uploadtime,
		});
		res.writeHead(200, corsHeaders(req));
		if (req.method === 'HEAD') {
			res.end();
			return;
		}
		res.end(body);
	}).catch((err: any) => {
		crashlogger(err, 'TCG replay read');
		if (!res.headersSent) {
			res.writeHead(500, corsHeaders(req));
			res.end('{"error":"replay read failed"}');
		}
	});
	return true;
}
