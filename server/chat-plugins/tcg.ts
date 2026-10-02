/**
 * TCG deck validate query for the Preact deck builder.
 * Uses Wave-TCG deckProblems (all errors), not sim/TeamValidator.
 */
import { deckProblems, loadCatalog } from '../../Wave-TCG';
import { isTcgFormat, parseTcgDeck, tcgRulesId } from '../tcg';

loadCatalog();

export const crqHandlers: { [k: string]: Chat.CRQHandler } = {
	/**
	 * /query tcgvalidate FORMATID JSON_DECK
	 * → { format, ok, errors: string[], deckSize, rulesSize }
	 */
	tcgvalidate(target) {
		const space = target.indexOf(' ');
		const formatid = space < 0 ? target : target.slice(0, space);
		const rawDeck = space < 0 ? '[]' : target.slice(space + 1).trim();
		if (!isTcgFormat(formatid)) {
			return { ok: false, format: formatid, errors: ['Not a TCG format.'], deckSize: 0, rulesSize: 0 };
		}
		const parsed = parseTcgDeck(rawDeck);
		if (!parsed.ok) {
			return { ok: false, format: formatid, errors: [parsed.error], deckSize: 0, rulesSize: 0 };
		}
		const rulesId = tcgRulesId(formatid);
		const { format, errors } = deckProblems(parsed.deck, rulesId);
		return {
			ok: !errors.length,
			format: formatid,
			rulesId: format.id,
			errors,
			deckSize: parsed.deck.length,
			rulesSize: format.deckSize,
		};
	},
};
