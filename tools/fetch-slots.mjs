/*
 * Fetches which equipment slot each item belongs to, from the OSRS Wiki's own
 * category listings, and writes tools/slots.json as { "item name": "slot" }.
 *
 * This is the single strongest constraint available for reading worn equipment:
 * a head slot can only ever hold a helmet, so restricting candidates to the
 * right slot removes almost the entire item list from consideration.
 */
import fs from 'node:fs';
import path from 'node:path';

const CATEGORIES = {
	head: ['Head slot items'],
	cape: ['Cape slot items'],
	neck: ['Neck slot items'],
	ammo: ['Ammunition slot items'],
	weapon: ['Weapon slot items', 'Two-handed slot items'],
	body: ['Body slot items'],
	shield: ['Shield slot items'],
	legs: ['Legs slot items'],
	hands: ['Hands slot items'],
	feet: ['Feet slot items'],
	ring: ['Ring slot items']
};

const API = 'https://oldschool.runescape.wiki/api.php';
const HEADERS = { 'User-Agent': 'banktag-converter (github.com/falko100/banktag-converter)' };

async function membersOf(category) {
	const titles = [];
	let cont = null;

	do {
		const url = new URL(API);
		url.searchParams.set('action', 'query');
		url.searchParams.set('format', 'json');
		url.searchParams.set('list', 'categorymembers');
		url.searchParams.set('cmtitle', 'Category:' + category);
		url.searchParams.set('cmlimit', '500');
		if (cont) {
			url.searchParams.set('cmcontinue', cont);
		}

		const res = await fetch(url, { headers: HEADERS });
		if (!res.ok) {
			throw new Error(`${category}: HTTP ${res.status}`);
		}
		const body = await res.json();
		for (const member of body.query.categorymembers) {
			if (member.ns === 0) {
				titles.push(member.title);
			}
		}
		cont = body.continue ? body.continue.cmcontinue : null;
	} while (cont);

	return titles;
}

const slots = {};
for (const [slot, categories] of Object.entries(CATEGORIES)) {
	let count = 0;
	for (const category of categories) {
		for (const title of await membersOf(category)) {
			// A two-handed weapon is in both its own category and the weapon one;
			// first write wins, and they agree.
			if (!slots[title]) {
				slots[title] = slot;
				count++;
			}
		}
	}
	console.log(`${slot.padEnd(8)} ${count}`);
}

fs.writeFileSync(path.join(import.meta.dirname, 'slots.json'), JSON.stringify(slots));
console.log('total named items with a slot:', Object.keys(slots).length);
