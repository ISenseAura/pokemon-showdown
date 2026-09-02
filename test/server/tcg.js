'use strict';

const assert = require('assert').strict;

const { makeUser } = require('../users-utils');

describe('TCG host', () => {
	describe('parseTcgDeck / isTcgFormat', () => {
		const { parseTcgDeck, isTcgFormat, tcgRulesId } = require('../../dist/server/tcg');

		it('detects Pocket by id and name', () => {
			assert.equal(isTcgFormat('tcgpocket'), true);
			assert.equal(isTcgFormat('[TCG] Pocket'), true);
			assert.equal(isTcgFormat('[TCG] Pocket Random'), true);
			assert.equal(isTcgFormat('tcgpocketrandom'), true);
			assert.equal(isTcgFormat('[TCG] Standard Random'), true);
			assert.equal(isTcgFormat('tcgstandardrandom'), true);
			assert.equal(isTcgFormat('gen9ou'), false);
			assert.equal(tcgRulesId('tcgpocket'), 'pocket');
			assert.equal(tcgRulesId('tcgpocketrandom'), 'pocketrandom');
			assert.equal(tcgRulesId('tcgstandard'), 'standard');
			assert.equal(tcgRulesId('tcgstandardrandom'), 'standardrandom');
		});

		it('parses empty, JSON, and packed VG teams', () => {
			assert.deepEqual(parseTcgDeck(''), { ok: true, deck: [] });
			assert.deepEqual(parseTcgDeck('["a1-1","a1-2"]'), { ok: true, deck: ['a1-1', 'a1-2'] });
			assert.equal(parseTcgDeck('Weavile||lifeorb||swordsdance|Jolly|').ok, false);
		});
	});

	describe('TcgBattleStream', () => {
		it('starts Pocket, rejects illegal acts, and hides the foe hand', async () => {
			const { TcgBattleStream } = require('../../dist/server/room-tcg');
			const stream = new TcgBattleStream();
			stream.write(
				'>start {"formatid":"tcgpocket","seed":1}\n' +
				'>player p1 {"name":"Alice","id":"alice","team":""}\n' +
				'>player p2 {"name":"Bob","id":"bob","team":""}'
			);

			const chunks = [];
			for (let i = 0; i < 5; i++) {
				const next = await stream.read();
				assert(next, `expected TCG stream chunk ${i + 1}`);
				chunks.push(next);
			}

			const p1Req = chunks.find(c => c.startsWith('sideupdate\np1\n|request|'));
			const p2Req = chunks.find(c => c.startsWith('sideupdate\np2\n|request|'));
			assert(p1Req, 'p1 should receive a request');
			assert(p2Req, 'p2 should receive a request');

			const p1 = JSON.parse(p1Req.split('|request|')[1]);
			const p2 = JSON.parse(p2Req.split('|request|')[1]);
			assert.equal(p1.tcg, true);
			assert.equal(p2.tcg, true);
			assert(Array.isArray(p1.snapshot.actions));
			assert(Array.isArray(p1.events));
			assert(p1.events.some(e => e.type === 'start' || e.type === 'request'),
				'construction should emit TcgEvents (start/request)');
			assert(typeof p1.seq === 'number');

			const you = p1.snapshot.players.find(p => p.id === 'alice');
			const foe = p1.snapshot.players.find(p => p.id === 'bob');
			assert(Array.isArray(you.hand), 'own hand should be card ids');
			assert(!Array.isArray(foe.hand), 'foe hand should be hidden');

			stream.write('>act p1 {"type":"attack","index":99}');
			const err = await stream.read();
			assert(err.includes('[Invalid choice]'));

			stream.destroy();
		});

		it('starts Pocket Random with empty decks', async function () {
			this.timeout(60000);
			const { TcgBattleStream } = require('../../dist/server/room-tcg');
			const stream = new TcgBattleStream();
			stream.write(
				'>start {"formatid":"tcgpocketrandom","seed":1}\n' +
				'>player p1 {"name":"Alice","id":"alice","team":""}\n' +
				'>player p2 {"name":"Bob","id":"bob","team":""}'
			);
			let p1Req = null;
			for (let i = 0; i < 8; i++) {
				const next = await stream.read();
				assert(next, `expected TCG stream chunk ${i + 1}`);
				if (next.startsWith('sideupdate\np1\n|request|')) p1Req = next;
				if (p1Req && next.startsWith('sideupdate\np2\n|request|')) break;
			}
			assert(p1Req, 'p1 should receive a request');
			const p1 = JSON.parse(p1Req.split('|request|')[1]);
			assert.equal(p1.tcg, true);
			assert(p1.snapshot.players[0].deck.count > 0 || Array.isArray(p1.snapshot.players[0].hand));
			stream.destroy();
		});

		it('starts Standard Random with generated decks', async function () {
			this.timeout(120000);
			const { TcgBattleStream } = require('../../dist/server/room-tcg');
			const stream = new TcgBattleStream();
			stream.write(
				'>start {"formatid":"tcgstandardrandom","seed":42}\n' +
				'>player p1 {"name":"Alice","id":"alice","team":""}\n' +
				'>player p2 {"name":"Bob","id":"bob","team":""}'
			);
			let p1Req = null;
			let failed = null;
			for (let i = 0; i < 10; i++) {
				const next = await stream.read();
				assert(next, `expected TCG stream chunk ${i + 1}`);
				if (next.includes('Invalid TCG deck') || next.includes('broadcast-red')) {
					failed = next;
					break;
				}
				if (next.startsWith('sideupdate\np1\n|request|')) p1Req = next;
				if (p1Req && next.startsWith('sideupdate\np2\n|request|')) break;
			}
			assert(!failed, failed || 'Standard Random should start with generated decks');
			assert(p1Req, 'p1 should receive a request');
			const p1 = JSON.parse(p1Req.split('|request|')[1]);
			assert.equal(p1.tcg, true);
			const you = p1.snapshot.players.find(p => p.id === 'alice');
			assert(you);
			assert.equal(you.hand.length + you.deck.count + (you.prizes?.count || 0), 60);
			stream.destroy();
		});
	});

	describe('RoomTcg', () => {
		let p1, p2, room;
		afterEach(() => {
			p1?.disconnectAll();
			p1?.destroy();
			p2?.disconnectAll();
			p2?.destroy();
			room?.destroy();
		});

		it('creates a TCG room instead of a video-game battle', () => {
			p1 = makeUser('TcgAlice');
			p2 = makeUser('TcgBob');
			room = Rooms.createBattle({
				format: '[TCG] Pocket',
				players: [{ user: p1, team: '' }, { user: p2, team: '' }],
			});
			assert(room);
			assert.equal(room.battle, null);
			assert.equal(room.game.gameid, 'tcg');
			assert.equal(room.active, true);
		});

		it('creates Pocket Random without a deck', () => {
			p1 = makeUser('TcgRandAlice');
			p2 = makeUser('TcgRandBob');
			room = Rooms.createBattle({
				format: '[TCG] Pocket Random',
				players: [{ user: p1, team: '' }, { user: p2, team: '' }],
			});
			assert(room);
			assert.equal(room.battle, null);
			assert.equal(room.game.gameid, 'tcg');
			assert.equal(Dex.formats.get('[TCG] Pocket Random').team, 'random');
		});

		it('creates Standard Random without a deck', () => {
			p1 = makeUser('TcgStdRandAlice');
			p2 = makeUser('TcgStdRandBob');
			room = Rooms.createBattle({
				format: '[TCG] Standard Random',
				players: [{ user: p1, team: '' }, { user: p2, team: '' }],
			});
			assert(room);
			assert.equal(room.battle, null);
			assert.equal(room.game.gameid, 'tcg');
			assert.equal(Dex.formats.get('[TCG] Standard Random').team, 'random');
			assert.equal(require('../../dist/server/tcg').tcgRulesId('tcgstandardrandom'), 'standardrandom');
		});
	});
});
