/*
 * Downloads every OSRS item icon into tools/icons/ so the signature database can
 * be rebuilt. ~21.6k files, roughly 85 MB, a few minutes on a warm connection.
 * Already-downloaded icons are skipped, so it is safe to re-run after a stall.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(import.meta.dirname, 'icons');
const namesFile = path.join(import.meta.dirname, 'names.json');
const CONCURRENCY = 24;

fs.mkdirSync(dir, { recursive: true });

if (!fs.existsSync(namesFile)) {
	console.log('Fetching item names...');
	const res = await fetch('https://static.runelite.net/cache/item/names.json');
	if (!res.ok) {
		console.error('Could not fetch item names: HTTP ' + res.status);
		process.exit(1);
	}
	fs.writeFileSync(namesFile, Buffer.from(await res.arrayBuffer()));
}

const names = JSON.parse(fs.readFileSync(namesFile, 'utf8'));
const queue = Object.keys(names).map(Number).sort((a, b) => a - b);
const total = queue.length;
let done = 0, saved = 0, missing = 0, retried = 0;

async function worker() {
	while (queue.length) {
		const id = queue.shift();
		const file = path.join(dir, id + '.png');
		if (fs.existsSync(file)) { done++; continue; }

		try {
			const res = await fetch(`https://static.runelite.net/cache/item/icon/${id}.png`);
			if (res.status === 200) {
				fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
				saved++;
			} else {
				missing++;   // a few ids have no icon in the cache
			}
		} catch {
			retried++;
			queue.push(id);  // transient failure, try again at the end
			continue;
		}
		if (++done % 2000 === 0) console.log(`${done}/${total}`);
	}
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`Done: ${done} checked, ${saved} downloaded, ${missing} with no icon, ${retried} retries.`);
