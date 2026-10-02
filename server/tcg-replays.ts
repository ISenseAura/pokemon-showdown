/**
 * Local TCG replay files. Playback is TcgBoard on the client host, not replay.pokemonshowdown.com.
 *
 * GET /replay/{id}.json  (also /replays/{id}.json)
 * Share URL: https://{client}/battle-{id}
 */
import * as http from 'http';
import * as path from 'path';
import { FS } from '../lib';

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
	return password ? `${id}-${password}pw` : id;
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

function corsHeaders() {
	return {
		'Access-Control-Allow-Origin': `https://${tcgClientHost()}`,
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Cache-Control': 'public, max-age=60',
		'Content-Type': 'application/json; charset=utf-8',
	};
}

/** SockJS HTTP: GET /replay/{id}.json and /replays/{id}.json */
export function serveTcgReplayHttp(req: http.IncomingMessage, res: http.ServerResponse): boolean {
	const pathOnly = (req.url || '').split('?')[0];
	const m = /^\/replays?\/([a-z0-9.-]+)$/i.exec(pathOnly);
	if (!m) return false;
	if (req.method === 'OPTIONS') {
		res.writeHead(204, corsHeaders());
		res.end();
		return true;
	}
	if (req.method !== 'GET' && req.method !== 'HEAD') return false;
	const { id, password } = parseReplayId(m[1]);
	if (!id) {
		res.writeHead(404, corsHeaders());
		res.end('{"error":"not found"}');
		return true;
	}
	void readTcgReplay(id, password).then(row => {
		if (!row) {
			res.writeHead(404, corsHeaders());
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
		res.writeHead(200, corsHeaders());
		if (req.method === 'HEAD') {
			res.end();
			return;
		}
		res.end(body);
	}).catch(() => {
		if (!res.headersSent) {
			res.writeHead(500, corsHeaders());
			res.end('{"error":"replay read failed"}');
		}
	});
	return true;
}
