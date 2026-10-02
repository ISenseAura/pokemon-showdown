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
	PokemonTcg, autoDeck, buildSampleDeck, chooseAction, loadCatalog, packGame, parseFormat, rollAssignedDeckPair, validateDeck,
} from '../Wave-TCG';
import { Replays } from './replays';

type TcgSlot = 'p1' | 'p2';
type TcgSeat = { id: string, name: string, deck: string[], cpu?: boolean };

const TICK_TIME = 5;
const SECONDS = 1000;
const STARTING_TIME = 150;
const MAX_TURN_TIME = 150;
const TIMER_COOLDOWN = 20 * SECONDS;

function requestIsWaiting(request: string): boolean {
	if (!request) return true;
	try {
		const data = JSON.parse(request) as { wait?: boolean, actions?: unknown[] };
		if (data.wait != null) return !!data.wait;
		return !data.actions?.length;
	} catch {
		return true;
	}
}

/** Inactivity timer for TCG — same `/timer` surface as RoomBattleTimer. */
export class RoomTcgTimer {
	readonly game: RoomTcg;
	readonly timerRequesters = new Set<ID>();
	timer: NodeJS.Timeout | null = null;
	lastTick = 0;
	lastDisabledTime = 0;
	lastDisabledByUser: ID | null = null;
	constructor(game: RoomTcg) {
		this.game = game;
		for (const player of game.players) {
			player.secondsLeft = STARTING_TIME;
			player.turnSecondsLeft = STARTING_TIME;
		}
	}
	start(requester?: User) {
		const userid = requester ? requester.id : 'staff' as ID;
		if (this.timerRequesters.has(userid)) return false;
		if (this.game.ended) {
			requester?.sendTo(this.game.roomid, `|inactiveoff|The timer can't be enabled after a battle has ended.`);
			return false;
		}
		if (this.timerRequesters.size) {
			this.game.room.add(`|inactive|${requester ? requester.name : userid} also wants the timer to be on.`).update();
			this.timerRequesters.add(userid);
			return false;
		}
		if (requester && this.game.playerTable[requester.id] && this.lastDisabledByUser === requester.id) {
			const cooldownLeft = (this.lastDisabledTime || 0) + TIMER_COOLDOWN - Date.now();
			if (cooldownLeft > 0) {
				this.game.playerTable[requester.id].sendRoom(
					`|inactiveoff|The timer can't be re-enabled so soon after disabling it (${Math.ceil(cooldownLeft / SECONDS)} seconds remaining).`
				);
				return false;
			}
		}
		this.timerRequesters.add(userid);
		const requestedBy = requester ? ` (requested by ${requester.name})` : ``;
		this.game.room.add(
			`|inactive|Battle timer is ON: inactive players will automatically lose when time's up.${requestedBy}`
		).update();
		for (const player of this.game.players) this.nextRequest(player);
		return true;
	}
	stop(requester?: User) {
		if (requester) {
			if (!this.timerRequesters.has(requester.id)) return false;
			this.timerRequesters.delete(requester.id);
			this.lastDisabledByUser = requester.id;
			this.lastDisabledTime = Date.now();
		} else {
			this.timerRequesters.clear();
		}
		if (this.timerRequesters.size) {
			this.game.room.add(
				`|inactive|${requester!.name} no longer wants the timer on, but the timer is staying on because ${[...this.timerRequesters].join(', ')} still does.`
			).update();
			return false;
		}
		if (this.end()) {
			this.game.room.add(`|inactiveoff|Battle timer is now OFF.`).update();
			return true;
		}
		return false;
	}
	end() {
		this.timerRequesters.clear();
		if (!this.timer) return false;
		clearTimeout(this.timer);
		this.timer = null;
		return true;
	}
	nextRequest(player: RoomTcgPlayer) {
		if (!this.timerRequesters.size || this.game.ended) return;
		if (requestIsWaiting(player.request)) {
			player.turnSecondsLeft = MAX_TURN_TIME;
			return;
		}
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		player.turnSecondsLeft = Math.min(player.secondsLeft, MAX_TURN_TIME);
		const secondsLeft = player.turnSecondsLeft;
		player.sendRoom(`|inactive|Time left: ${secondsLeft} sec this turn | ${player.secondsLeft} sec total`);
		if (secondsLeft <= 30) {
			this.game.room.add(`|inactive|${player.name} has ${secondsLeft} seconds left this turn.`);
		}
		this.game.room.update();
		this.lastTick = Date.now();
		this.timer = setTimeout(() => this.nextTick(), TICK_TIME * SECONDS);
	}
	nextTick() {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		if (this.game.ended || !this.timerRequesters.size) return;
		const room = this.game.room;
		const active = this.game.players.filter(p => !requestIsWaiting(p.request));
		if (!active.length) return;
		for (const player of active) {
			player.secondsLeft -= TICK_TIME;
			player.turnSecondsLeft -= TICK_TIME;
			if (player.turnSecondsLeft <= 0 || player.secondsLeft <= 0) {
				player.secondsLeft = 0;
				player.turnSecondsLeft = 0;
				room.add(`|inactive|${player.name} has timed out.`).update();
				this.end();
				this.game.forfeit(player.id);
				return;
			}
			if (player.turnSecondsLeft % 30 === 0 || player.turnSecondsLeft <= 20) {
				player.sendRoom(
					`|inactive|Time left: ${player.turnSecondsLeft} sec this turn | ${player.secondsLeft} sec total`
				);
			}
			if (player.turnSecondsLeft <= 30 && player.turnSecondsLeft % TICK_TIME === 0) {
				room.add(`|inactive|${player.name} has ${player.turnSecondsLeft} seconds left this turn.`);
			}
		}
		room.update();
		this.lastTick = Date.now();
		this.timer = setTimeout(() => this.nextTick(), TICK_TIME * SECONDS);
	}
}

/**
 * Host wire per Wave-TCG docs/events.md:
 * after start/act → viewEvents per seat + snapshot for resync.
 * Graphics animate TcgEvent[]; do not invent motion from TcgFlash.
 */
/** Client-facing format fields only (full FormatRules is ~576 B of legality noise). */
type TcgWireFormat = {
	id: string, name: string, benchSize: number, prizes: number, energyZone?: boolean,
};

/** Snapshot on the wire: no chat log; format only on the first batch of a game. */
type TcgWireSnapshot = Omit<TcgSnapshot, 'log' | 'format'> & { format?: TcgWireFormat };

export class TcgBattleStream extends Streams.ObjectReadWriteStream<string> {
	game: PokemonTcg | null = null;
	formatid = 'tcgpocket';
	roomid = '';
	seed: number | undefined;
	private seats: Partial<Record<TcgSlot, TcgSeat>> = {};
	private cpuSlots = new Set<TcgSlot>();
	private cpuTimer: NodeJS.Timeout | null = null;
	private lastTurn = 0;
	/** Format is static for the battle; send it once, then omit. */
	private formatSent = false;
	/** Full board snapshot sent at least once (join / first batch). */
	private snapshotSent = false;

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
		const rulesId = tcgRulesId(this.formatid);
		const rules = parseFormat(rulesId);
		let deck1: string[];
		let deck2: string[];
		const baseSeed = this.seed || 1;
		const sample = (existing: string[], type: 'grass' | 'fire', seed: number) => {
			if (existing.length) return existing;
			try {
				return buildSampleDeck(rules.id, type);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (!/No .+ Pokemon in/.test(message)) throw err;
				return autoDeck(rules.id, { seed, anyCard: true });
			}
		};
		try {
			// *random ids assign decks even when this checkout's format list
			// still resolves them to the base format (Standard).
			if (rules.assignedDeck) {
				[deck1, deck2] = rollAssignedDeckPair(rules.id, this.seed);
			} else if (rulesId.endsWith('random')) {
				deck1 = autoDeck(rules.id, { seed: baseSeed, anyCard: true });
				deck2 = autoDeck(rules.id, { seed: baseSeed + 7919, anyCard: true });
			} else {
				deck1 = sample(this.seats.p1.deck, 'grass', baseSeed);
				deck2 = sample(this.seats.p2.deck, 'fire', baseSeed + 7919);
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.push(`update\n|html|<div class="broadcast-red"><b>Could not build TCG decks</b><br />${Utils.escapeHTML(message)}</div>`);
			this.push(`end\n${JSON.stringify({ winner: '', inputLog: [] })}`);
			return;
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

	/** Strip chat log; attach slim format only on the first batch of the game. */
	private wireSnap(snap: TcgSnapshot, includeFormat: boolean): TcgWireSnapshot {
		const { log: _log, format, ...rest } = snap;
		const out: TcgWireSnapshot = rest;
		if (includeFormat && format) {
			out.format = {
				id: format.id,
				name: format.name,
				benchSize: format.benchSize,
				prizes: format.prizes,
				...(format.energyZone ? { energyZone: true } : {}),
			};
		}
		return out;
	}

	/**
	 * Full board snapshots are for join / turn boundaries / structural changes / prompts.
	 * Soft mid-turn batches (attach energy, damage, etc.) send events + actions only.
	 */
	private needsSnapshot(events: TcgEvent[]): boolean {
		if (!this.snapshotSent) return true;
		if (this.game?.status === 'over') return true;
		/** Events that reshape the board or need pending* UI from a fresh snapshot. */
		const hard = new Set([
			'start', 'first', 'deal', 'turn', 'over',
			'place', 'evolve', 'ko', 'prize', 'prizeTake', 'points',
			'stadium', 'stadiumEnd',
		]);
		for (const e of events) {
			if (hard.has(e.type)) return true;
			if (e.type === 'request' && e.kind && e.kind !== 'turn') return true;
		}
		return false;
	}

	/** Forward one act/construction batch: events always; snapshot when needed for resync. */
	private pushBatch(events: TcgEvent[]) {
		if (!this.game) return;
		const seq = this.game.eventSeq;
		const includeFormat = !this.formatSent;
		const includeSnap = this.needsSnapshot(events);
		this.formatSent = true;
		if (includeSnap) this.snapshotSent = true;
		const pack = includeSnap ? packGame(this.game) : null;
		const update = ['update'];
		for (const e of events) {
			if (e.type === 'turn' && e.number && e.number !== this.lastTurn) {
				update.push(`|turn|${e.number}`);
				this.lastTurn = e.number;
			}
		}
		const watchPayload: { kind: string, seq: number, events: TcgEvent[], snapshot?: TcgWireSnapshot } = {
			kind: 'watch',
			seq,
			events: this.game.viewEvents(undefined, events),
		};
		if (pack) watchPayload.snapshot = this.wireSnap(pack.watch, includeFormat);
		update.push(`|tcg|${JSON.stringify(watchPayload)}`);
		this.push(update.join('\n'));
		const p1 = this.seats.p1!;
		const p2 = this.seats.p2!;
		this.side(
			'p1',
			pack ? this.wireSnap(pack.views[p1.id] || this.game.snapshot(p1.id), includeFormat) : null,
			this.game.viewEvents(p1.id, events),
			seq,
			pack ? undefined : this.game.legalActions(p1.id),
		);
		this.side(
			'p2',
			pack ? this.wireSnap(pack.views[p2.id] || this.game.snapshot(p2.id), includeFormat) : null,
			this.game.viewEvents(p2.id, events),
			seq,
			pack ? undefined : this.game.legalActions(p2.id),
		);
	}

	private side(
		slot: TcgSlot,
		snap: TcgWireSnapshot | null,
		events: TcgEvent[],
		seq: number,
		actionsOverride?: TcgAction[],
	) {
		const requestEv = events.find(e => e.type === 'request') as
			| Extract<TcgEvent, { type: 'request' }> | undefined;
		const actions = actionsOverride || snap?.actions || [];
		const payload: {
			tcg: true, seq: number, wait: boolean, events: TcgEvent[], actions: TcgAction[],
			snapshot?: TcgWireSnapshot,
			request?: { kind: string, waiting: (0 | 1)[] },
		} = {
			tcg: true,
			seq,
			wait: !actions.length,
			events,
			actions,
			request: requestEv ? { kind: requestEv.kind, waiting: requestEv.waiting } : undefined,
		};
		if (snap) payload.snapshot = snap;
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
	secondsLeft = STARTING_TIME;
	turnSecondsLeft = STARTING_TIME;
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
	override timer: RoomTcgTimer;
	/** Spectator opening board for uploaded replays. */
	replaySnapshot: TcgSnapshot | null = null;
	/** Spectator-filtered events accumulated for upload. */
	replayEvents: TcgEvent[] = [];
	replaySaved: boolean | 'auto' = false;
	winnerName = '';

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
		this.timer = new RoomTcgTimer(this);
		void this.listen();
		void this.stream.write(`>start ${JSON.stringify({
			formatid: this.format,
			roomid: this.roomid,
			seed: Array.isArray(options.seed) ? Number(options.seed[0]) : undefined,
		})}`);

		this.room.add(`|tier|${format.name}`);
		const randomNote = Dex.formats.get(this.format).team ?
			`Decks are assigned at random. No deck required.` :
			`An empty deck uses a sample Pocket deck.`;
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
		if (Config.forcetimer || this.format.includes('blitz')) this.timer.start();
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
			for (const line of lines.slice(1)) {
				this.ingestReplayLine(line);
				this.room.add(line);
			}
			this.room.update();
			break;
		case 'sideupdate': {
			const slot = lines[1] as TcgSlot;
			const player = this[slot];
			const rest = lines.slice(2).join('\n');
			if (rest.startsWith('|request|')) {
				player.request = rest.slice('|request|'.length);
				this.timer.nextRequest(player);
			}
			player.sendRoom(rest);
			break;
		}
		case 'end': {
			const data = JSON.parse(lines[1] || '{}') as { winner?: string };
			this.room.active = false;
			this.winnerName = data.winner || '';
			this.timer.end();
			this.setEnded();
			if (data.winner) this.room.add(`|win|${data.winner}`);
			else this.room.add(`|tie`);
			this.room.update();
			if (Config.autosavereplays) {
				void this.uploadReplay(undefined, undefined, 'auto');
			}
			break;
		}
		case 'error':
			Monitor.crashlog(new Error(lines.slice(1).join('\n')), 'A TCG battle');
			break;
		}
	}

	/** Record spectator watch batches for `/savereplay`. */
	ingestReplayLine(line: string) {
		if (!line.startsWith('|tcg|')) return;
		try {
			const data = JSON.parse(line.slice('|tcg|'.length)) as {
				kind?: string, snapshot?: TcgSnapshot, events?: TcgEvent[],
			};
			if (data.kind && data.kind !== 'watch') return;
			if (data.snapshot && !this.replaySnapshot) {
				this.replaySnapshot = data.snapshot;
			}
			if (data.events?.length) {
				for (const ev of data.events) this.replayEvents.push(ev);
			}
		} catch {}
	}

	getTcgReplayLog() {
		const format = Dex.formats.get(this.format, true);
		const payload = {
			format: format.id,
			formatName: format.name,
			p1: this.p1?.name || '',
			p2: this.p2?.name || '',
			winner: this.winnerName,
			replay: {
				snapshot: this.replaySnapshot,
				events: this.replayEvents,
			},
		};
		return `|tcgreplay|${JSON.stringify(payload)}`;
	}

	async uploadReplay(user?: User, connection?: Connection, options?: 'forpunishment' | 'silent' | 'auto') {
		const format = Dex.formats.get(this.format, true);
		const log = this.getTcgReplayLog();
		if (!this.replaySnapshot) {
			connection?.popup(`This TCG battle has no replay data yet.`);
			return;
		}
		let rating: number | undefined;
		if (this.ended && this.rated) rating = this.rated;
		let { id, password } = this.room.getReplayData();
		const silent = options === 'forpunishment' || options === 'silent' || options === 'auto';
		if (silent) connection = undefined;
		const isPrivate = this.room.settings.isPrivate || this.room.hideReplay;
		const hidden = options === 'auto' ? 10 :
			options === 'forpunishment' || (this.room as any).unlistReplay ? 2 :
			isPrivate ? 1 :
			0;
		if (isPrivate && hidden !== 2) {
			password = password || Replays.generatePassword();
		}
		if (this.replaySaved !== true && hidden === 10) {
			this.replaySaved = 'auto';
		} else {
			this.replaySaved = true;
		}

		if (Replays.db) {
			const idWithServer = Config.serverid === 'showdown' ? id : `${Config.serverid}-${id}`;
			try {
				const fullid = await Replays.add({
					id: idWithServer,
					log,
					players: this.players.map(p => p.name),
					format: format.name,
					rating: Math.round(rating || 0) || null,
					private: hidden,
					password,
					inputlog: null,
					uploadtime: Math.trunc(Date.now() / 1000),
				});
				const url = `https://${Config.routes.replays}/${fullid}`;
				connection?.popup(
					`|html|<p>Your replay has been uploaded! It's available at:</p><p> ` +
					`<a class="no-panel-intercept" href="${url}" target="_blank">${url}</a> ` +
					`<copytext value="${url}">Copy</copytext>`
				);
			} catch (e) {
				connection?.popup(`Your replay could not be saved: ${e}`);
				throw e;
			}
			return;
		}

		const [result] = await LoginServer.request('addreplay', {
			id,
			log,
			players: this.players.map(p => p.name).join(','),
			format: format.name,
			rating,
			hidden: hidden === 0 ? '' : hidden,
			password,
		});
		if (result?.errorip) {
			connection?.popup(`This server's request IP ${result.errorip} is not a registered server.`);
			return;
		}
		const fullid = result?.replayid;
		const url = `https://${Config.routes.replays}/${fullid}`;
		connection?.popup(
			`|html|<p>Your replay has been uploaded! It's available at:</p><p> ` +
			`<a class="no-panel-intercept" href="${url}" target="_blank">${url}</a> ` +
			`<copytext value="${url}">Copy</copytext>`
		);
	}

	override destroy() {
		this.timer.end();
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
