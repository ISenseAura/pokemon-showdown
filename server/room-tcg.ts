/**
 * TCG battle room — hosts WaveTCG (legalActions / act / snapshot).
 * Isolation matches RoomBattle (StreamProcessManager). Protocol is TCG JSON.
 *
 * @license MIT
 */

import { ProcessManager, Utils, Streams } from '../lib';
import { RoomGamePlayer, RoomGame } from './room-game';
import * as ConfigLoader from './config-loader';
import type { RoomBattleOptions, RoomBattlePlayerOptions } from './room-battle';
import { parseTcgDeck, tcgRulesId } from './tcg';
import type { TcgAction, TcgEvent, TcgSnapshot } from '../Wave-TCG/types';
import { decodeAction } from '../Wave-TCG/protocol/encode';
import {
	PokemonTcg, buildSampleDeck, chooseAction, loadCatalog, packGame, parseFormat, rollAssignedDeckPair, validateDeck,
} from '../Wave-TCG';

type TcgSlot = 'p1' | 'p2';
type TcgSeat = { id: string, name: string, deck: string[], cpu?: boolean };

/**
 * Host wire per Wave-TCG docs/events.md:
 * after start/act → viewEvents per seat + snapshot for resync.
 * Graphics animate TcgEvent[]; do not invent motion from TcgFlash.
 */
export class TcgBattleStream extends Streams.ObjectReadWriteStream<string> {
	game: PokemonTcg | null = null;
	formatid = 'tcgpocket';
	roomid = '';
	seed: number | undefined;
	private seats: Partial<Record<TcgSlot, TcgSeat>> = {};
	private cpuSlots = new Set<TcgSlot>();
	private cpuTimer: NodeJS.Timeout | null = null;
	private lastTurn = 0;

	override _write(chunk: string) {
		const startTime = Date.now();
		try {
			for (const line of chunk.split('\n')) {
				if (!line.startsWith('>')) continue;
				const sp = line.indexOf(' ');
				const type = sp < 0 ? line.slice(1) : line.slice(1, sp);
				const message = sp < 0 ? '' : line.slice(sp + 1);
				this.handle(type, message);
			}
		} catch (err: any) {
			Monitor.crashlog(err, 'A TCG battle', { chunk });
			this.push(`update\n|html|<div class="broadcast-red"><b>The TCG battle crashed</b></div>`);
			this.push(`error\n${err.stack}`);
		}
		const deltaTime = Date.now() - startTime;
		if (deltaTime > 1000) {
			Monitor.slow(`[slow tcg] ${deltaTime}ms - ${chunk.replace(/\n/ig, ' | ')}`);
		}
	}

	private handle(type: string, message: string) {
		switch (type) {
		case 'start': {
			const opts = JSON.parse(message) as { formatid?: string, roomid?: string, seed?: number };
			this.formatid = opts.formatid || 'tcgpocket';
			this.roomid = opts.roomid || '';
			this.seed = opts.seed;
			break;
		}
		case 'cpu': {
			const slot = message.trim() as TcgSlot;
			this.cpuSlots.add(slot);
			const seat = this.seats[slot];
			if (seat) seat.cpu = true;
			this.scheduleCpu();
			break;
		}
		case 'player': {
			const sp = message.indexOf(' ');
			const slot = (sp < 0 ? message : message.slice(0, sp)) as TcgSlot;
			const rest = sp < 0 ? '{}' : message.slice(sp + 1);
			const data = JSON.parse(rest) as { name?: string, team?: string, id?: string };
			if (!data.name) {
				delete this.seats[slot];
				break;
			}
			const parsed = parseTcgDeck(data.team);
			this.seats[slot] = {
				id: data.id || slot,
				name: data.name,
				deck: parsed.ok ? parsed.deck : [],
				cpu: this.cpuSlots.has(slot),
			};
			this.tryBegin();
			break;
		}
		case 'act': {
			const sp = message.indexOf(' ');
			const slot = message.slice(0, sp) as TcgSlot;
			const action = JSON.parse(message.slice(sp + 1)) as TcgAction;
			this.doAct(slot, action);
			break;
		}
		case 'forfeit':
		case 'forcelose': {
			const slot = message.trim() as TcgSlot;
			if (!this.game || this.game.status === 'over') break;
			const loser = this.seats[slot];
			if (!loser) break;
			this.game.forfeit(loser.id);
			this.pushBatch(this.game.lastEvents);
			this.emitEnd();
			break;
		}
		}
	}

	private tryBegin() {
		if (this.game || !this.seats.p1 || !this.seats.p2) return;
		loadCatalog();
		process.env.PTCG_PROTOCOL_LOG = '0';
		const rules = parseFormat(tcgRulesId(this.formatid));
		let deck1: string[];
		let deck2: string[];
		if (rules.assignedDeck) {
			[deck1, deck2] = rollAssignedDeckPair(rules.id, this.seed);
		} else {
			deck1 = this.seats.p1.deck.length ? this.seats.p1.deck : buildSampleDeck(rules.id, 'grass');
			deck2 = this.seats.p2.deck.length ? this.seats.p2.deck : buildSampleDeck(rules.id, 'fire');
		}
		const v1 = validateDeck(deck1, rules.id);
		const v2 = validateDeck(deck2, rules.id);
		if (!v1.ok || !v2.ok) {
			let err = '';
			if (!v1.ok) err = v1.error;
			else if (!v2.ok) err = v2.error;
			this.push(`update\n|html|<div class="broadcast-red"><b>Invalid TCG deck</b><br />${Utils.escapeHTML(err)}</div>`);
			this.push(`end\n${JSON.stringify({ winner: '', inputLog: [] })}`);
			return;
		}
		this.game = PokemonTcg.start(
			[
				{ id: this.seats.p1.id, name: this.seats.p1.name, deck: deck1 },
				{ id: this.seats.p2.id, name: this.seats.p2.name, deck: deck2 },
			],
			{
				format: rules,
				seed: this.seed,
				roomId: this.roomid,
				replay: false,
			}
		);
		// Construction fills lastEvents (start / first / deal / request).
		this.pushBatch(this.game.lastEvents);
		this.scheduleCpu();
	}

	private doAct(slot: TcgSlot, action: TcgAction) {
		if (!this.game) {
			this.push(`sideupdate\n${slot}\n|error|[Invalid choice] The game has not started`);
			return;
		}
		const who = this.seats[slot]?.id;
		if (!who) return;
		const result = this.game.act(who, action);
		if (!result.ok) {
			this.push(`sideupdate\n${slot}\n|error|[Invalid choice] ${result.error}`);
			return;
		}
		this.pushBatch(result.events);
		if (this.game.status === 'over') this.emitEnd();
		else this.scheduleCpu();
	}

	private cpuToMove(): TcgSlot | null {
		if (!this.game || this.game.status === 'over') return null;
		for (const slot of ['p1', 'p2'] as const) {
			const seat = this.seats[slot];
			if (!seat?.cpu) continue;
			if (this.game.legalActions(seat.id).length) return slot;
		}
		return null;
	}

	private scheduleCpu() {
		if (this.cpuTimer || !this.cpuToMove()) return;
		this.cpuTimer = setTimeout(() => {
			this.cpuTimer = null;
			this.playCpu();
		}, 600);
	}

	private playCpu() {
		const slot = this.cpuToMove();
		if (!slot || !this.game) return;
		const seat = this.seats[slot]!;
		const action = chooseAction(this.game, seat.id);
		if (!action) return;
		this.doAct(slot, action);
	}

	/** Forward one act/construction batch: filtered events + snapshot resync. */
	private pushBatch(events: TcgEvent[]) {
		if (!this.game) return;
		const pack = packGame(this.game);
		const seq = this.game.eventSeq;
		const update = ['update'];
		for (const e of events) {
			if (e.type === 'turn' && e.number && e.number !== this.lastTurn) {
				update.push(`|turn|${e.number}`);
				this.lastTurn = e.number;
			}
		}
		update.push(`|tcg|${JSON.stringify({
			kind: 'watch',
			seq,
			events: this.game.viewEvents(undefined, events),
			snapshot: pack.watch,
		})}`);
		this.push(update.join('\n'));
		const p1 = this.seats.p1!;
		const p2 = this.seats.p2!;
		this.side(
			'p1',
			pack.views[p1.id] || this.game.snapshot(p1.id),
			this.game.viewEvents(p1.id, events),
			seq,
		);
		this.side(
			'p2',
			pack.views[p2.id] || this.game.snapshot(p2.id),
			this.game.viewEvents(p2.id, events),
			seq,
		);
	}

	private side(slot: TcgSlot, snap: TcgSnapshot, events: TcgEvent[], seq: number) {
		const requestEv = events.find(e => e.type === 'request') as
			| Extract<TcgEvent, { type: 'request' }> | undefined;
		const payload = {
			tcg: true,
			seq,
			wait: !snap.actions.length,
			snapshot: snap,
			events,
			actions: snap.actions,
			request: requestEv ? { kind: requestEv.kind, waiting: requestEv.waiting } : undefined,
		};
		this.push(`sideupdate\n${slot}\n|request|${JSON.stringify(payload)}`);
		this.push(`sideupdate\n${slot}\n|tcg|${JSON.stringify({ kind: 'you', ...payload })}`);
	}

	private emitEnd() {
		if (!this.game) return;
		const winner = this.game.winner == null ? '' : this.game.players[this.game.winner].name;
		this.push(`end\n${JSON.stringify({
			winner,
			winReason: this.game.winReason,
			inputLog: [],
		})}`);
	}
}

export class RoomTcgPlayer extends RoomGamePlayer<RoomTcg> {
	readonly slot: TcgSlot;
	request = '';
	constructor(user: User | string | null, game: RoomTcg, num: 1 | 2) {
		super(user, game, num);
		this.slot = `p${num}` as TcgSlot;
	}
}

export class RoomTcg extends RoomGame<RoomTcgPlayer> {
	override readonly gameid = 'tcg' as ID;
	override readonly room!: GameRoom;
	readonly format: string;
	readonly rated: number;
	readonly stream: Streams.ObjectReadWriteStream<string>;
	p1!: RoomTcgPlayer;
	p2!: RoomTcgPlayer;
	started = true;
	forcedSettings: { modchat?: string | null, privacy?: string | null } = {};
	options: RoomBattleOptions;
	override allowRenames: boolean;

	constructor(room: GameRoom, options: RoomBattleOptions) {
		super(room);
		const format = Dex.formats.get(options.format, true);
		this.title = format.name.endsWith(' Battle') ? format.name : `${format.name} Battle`;
		this.format = options.format;
		this.options = options;
		this.rated = options.rated === true ? 1 : options.rated || 0;
		this.playerCap = 2;
		this.allowRenames = options.allowRenames !== undefined ? !!options.allowRenames : (!options.rated && !options.tour);
		this.stream = PM.createStream();
		void this.listen();
		void this.stream.write(`>start ${JSON.stringify({
			formatid: this.format,
			roomid: this.roomid,
			seed: Array.isArray(options.seed) ? Number(options.seed[0]) : undefined,
		})}`);

		this.room.add(`|tier|${format.name}`);
		const randomNote = Dex.formats.get(this.format).team ?
			`Decks are assigned at random. No team required.` :
			`Empty teams use a sample Pocket deck.`;
		this.room.add(
			`|html|<div class="broadcast-blue"><strong>${Utils.escapeHTML(format.name)}</strong> (WaveTCG)<br />` +
			`Graphics: animate <code>TcgEvent</code>s from <code>|tcg|</code>; snapshot for join/resync. ` +
			`Play with <code>/choose {JSON TcgAction}</code>. ${randomNote}</div>`
		);

		for (let i = 0; i < options.players.length; i++) {
			const p = options.players[i];
			const player = this.addPlayer(p?.user || null, p || null);
			if (!player) throw new Error(`failed to create TCG player ${i + 1} in ${room.roomid}`);
		}
		if (options.cpu && options.players.length < 2) {
			const cpu = this.addPlayer('CPU', { team: '' } as RoomBattlePlayerOptions);
			if (cpu) {
				void this.stream.write(`>cpu ${cpu.slot}`);
				this.room.add(`|player|${cpu.slot}|CPU|1|`);
			}
		}
		this.room.title = `${this.p1.name} vs ${this.p2.name}`;
		this.room.send(`|title|${this.room.title}`);
		this.room.active = true;
		const users = this.players.map(player => player.getUser()).filter(Boolean) as User[];
		Rooms.global.onCreateBattleRoom(users, this.room, { rated: this.rated });
	}

	override makePlayer(user: User | string | null) {
		const num = (this.players.length + 1) as 1 | 2;
		return new RoomTcgPlayer(user, this, num);
	}

	override addPlayer(user: User | string | null, playerOpts?: RoomBattlePlayerOptions | null) {
		const player = super.addPlayer(user);
		if (typeof user === 'string') user = null;
		if (!player) return null;
		this[player.slot] = player;
		if (playerOpts) {
			void this.stream.write(`>player ${player.slot} ${JSON.stringify({
				id: player.id || player.slot,
				name: player.name,
				team: playerOpts.team || '',
			})}`);
		}
		if (user) {
			this.room.auth.set(player.id, Users.PLAYER_SYMBOL);
			this.room.add(`|player|${player.slot}|${player.name}|${user.avatar}|`);
		}
		if (user?.inRooms.has(this.roomid)) this.onConnect(user);
		return player;
	}

	override choose(user: User, data: string) {
		const player = this.playerTable[user.id];
		if (!player) return;
		const [choice] = data.split('|', 2);
		const raw = choice.trim();
		let action: TcgAction | null = null;
		try {
			if (raw.startsWith('{')) {
				action = JSON.parse(raw) as TcgAction;
			} else {
				action = decodeAction(raw);
			}
		} catch {
			action = null;
		}
		if (!action) {
			player.sendRoom(`|error|[Invalid choice] Send a JSON TcgAction or an encoded token (WaveTCG encodeAction).`);
			return;
		}
		void this.stream.write(`>act ${player.slot} ${JSON.stringify(action)}`);
	}

	override forfeit(user: User | string) {
		const id = typeof user === 'string' ? toID(user) : user.id;
		const player = this.playerTable[id];
		if (!player || this.ended) return false;
		this.room.add(`|-message|${player.name} forfeited.`);
		void this.stream.write(`>forfeit ${player.slot}`);
		return true;
	}

	override onConnect(user: User) {
		const player = this.playerTable[user.id];
		if (player?.request) {
			player.sendRoom(`|request|${player.request}`);
		}
	}

	override onJoin(user: User) {
		const player = this.playerTable[user.id];
		if (player) this.room.add(`|player|${player.slot}|${user.name}|${user.avatar}|`);
	}

	checkPrivacySettings(options: RoomBattleOptions) {
		let inviteOnly = false;
		const privacySetter = new Set<ID>([]);
		for (const p of options.players) {
			if (!p.user) continue;
			if (p.inviteOnly) {
				inviteOnly = true;
				privacySetter.add(p.user.id);
			} else if (p.hidden) {
				privacySetter.add(p.user.id);
			}
		}
		if (!privacySetter.size) return;
		this.room.setPrivate('hidden');
		this.room.privacySetter = privacySetter;
		if (inviteOnly) {
			this.room.settings.modjoin = '%';
			this.room.add(`|raw|<div class="broadcast-red"><strong>This battle is invite-only!</strong></div>`);
		}
	}

	async listen() {
		try {
			for await (const next of this.stream) {
				if (!this.room) return;
				this.receive(next.split('\n'));
			}
		} catch (err: any) {
			if (!err.message?.includes('Process disconnected')) {
				Monitor.crashlog(err, 'A TCG stream');
			}
			if (!this.ended) {
				this.room.add(`|bigerror|The TCG simulator process crashed.`);
				this.setEnded();
			}
		}
	}

	receive(lines: string[]) {
		switch (lines[0]) {
		case 'update':
			for (const line of lines.slice(1)) this.room.add(line);
			this.room.update();
			break;
		case 'sideupdate': {
			const slot = lines[1] as TcgSlot;
			const player = this[slot];
			const rest = lines.slice(2).join('\n');
			if (rest.startsWith('|request|')) player.request = rest.slice('|request|'.length);
			player.sendRoom(rest);
			break;
		}
		case 'end': {
			const data = JSON.parse(lines[1] || '{}') as { winner?: string };
			this.room.active = false;
			this.setEnded();
			if (data.winner) this.room.add(`|win|${data.winner}`);
			else this.room.add(`|tie`);
			this.room.update();
			break;
		}
		case 'error':
			Monitor.crashlog(new Error(lines.slice(1).join('\n')), 'A TCG battle');
			break;
		}
	}

	override destroy() {
		void this.stream.destroy();
		super.destroy();
	}
}

export const PM = new ProcessManager.StreamProcessManager('tcg', module, () => new TcgBattleStream(), message => {
	if (message.startsWith(`SLOW\n`)) {
		Monitor.slow(message.slice(5));
	}
});

export function start(processCount: ConfigLoader.SubProcessesConfig) {
	PM.spawn(processCount['tcg'] ?? 1);
}

if (!PM.isParentProcess) {
	ConfigLoader.ensureLoaded();
	process.env.PTCG_PROTOCOL_LOG = '0';
	try {
		require('source-map-support').install();
	} catch {}
	global.Monitor = {
		crashlog(error: Error, source = 'A TCG process', details: AnyObject | null = null) {
			const repr = JSON.stringify([error.name, error.message, source, details]);
			process.send!(`THROW\n@!!@${repr}\n${error.stack}`);
		},
		slow(text: string) {
			process.send!(`CALLBACK\nSLOW\n${text}`);
		},
	};
	global.__version = { head: '' };
	if (Config.crashguard) {
		process.on('uncaughtException', err => {
			Monitor.crashlog(err, 'A TCG process');
		});
		process.on('unhandledRejection', err => {
			Monitor.crashlog(err as any || {}, 'A TCG process Promise');
		});
	}
	loadCatalog();
	// eslint-disable-next-line no-eval
	PM.startRepl(cmd => eval(cmd));
}
