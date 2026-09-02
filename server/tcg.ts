/**
 * Pokémon TCG (WaveTCG) helpers for the Showdown host.
 * Format ids live in config/formats.ts; rules live in Wave-TCG.
 * Do not route these through sim/TeamValidator.
 *
 * Local toID — the TCG worker does not have the Dex/toID globals.
 */

function toID(text: string | { id?: string, name?: string } | null | undefined): string {
	if (text && typeof text === 'object') text = text.id || text.name || '';
	return `${text || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const TCG_FORMATS: { [id: string]: string } = {
	tcgpocket: 'pocket',
	tcgpocketrandom: 'pocketrandom',
	tcgstandard: 'standard',
	tcgstandardrandom: 'standardrandom',
};

export function isTcgFormat(format: { id?: string, name?: string } | string): boolean {
	const id = typeof format === 'string' ? toID(format) : toID(format.id || format.name || '');
	if (id.startsWith('tcg')) return true;
	if (typeof format === 'object' && format.name?.includes('[TCG]')) return true;
	return false;
}

/** WaveTCG format id (`pocket`) from a Showdown format id (`tcgpocket`). */
export function tcgRulesId(formatid: string): string {
	const id = toID(formatid);
	return TCG_FORMATS[id] || (id.startsWith('tcg') ? id.slice(3) : 'pocket');
}

/**
 * Parse a TCG deck from the teambuilder / challenge team field.
 * Empty string → sample deck (assigned in the TCG worker).
 */
export function parseTcgDeck(
	raw: string | undefined | null
): { ok: true, deck: string[] } | { ok: false, error: string } {
	const s = String(raw || '').trim();
	if (!s) return { ok: true, deck: [] };
	if (s.startsWith('[')) {
		try {
			const v = JSON.parse(s) as unknown;
			if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x)) {
				return { ok: false, error: 'TCG deck JSON must be an array of card ids (strings).' };
			}
			return { ok: true, deck: v };
		} catch {
			return { ok: false, error: 'TCG deck JSON could not be parsed.' };
		}
	}
	if (s.includes('|')) {
		return {
			ok: false,
			error: 'That looks like a Pokémon video-game team. Paste a JSON array of TCG card ids, or leave the team empty for a sample Pocket deck.',
		};
	}
	return { ok: true, deck: s.split(/[\s,]+/).filter(Boolean) };
}
