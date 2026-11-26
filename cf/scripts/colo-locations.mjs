// Regenerates colo-locations.json: each Cloudflare data center and the D1/R2 location hint nearest to it.
import { writeFile } from 'node:fs/promises';

/** Points inside each hint's area: SJC, IAD, FRA, Marseille (where Africa's cables land), WAW, NRT, SIN, SYD. */
const anchors = [['wnam', 37.4, -121.9], ['enam', 38.9, -77.5], ['weur', 50.0, 8.6], ['weur', 43.4, 5.2], ['eeur', 52.2, 21.0], ['apac', 35.8, 140.4], ['apac', 1.4, 104.0], ['oc', -33.9, 151.2]];
const rad = Math.PI / 180;
const angle = (lat1, lon1, lat2, lon2) => Math.acos(Math.min(1, Math.sin(lat1 * rad) * Math.sin(lat2 * rad) + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon1 - lon2) * rad)));
const colos = await (await fetch('https://speed.cloudflare.com/locations', { headers: { referer: 'https://speed.cloudflare.com/' } })).json();
const lines = colos.map(({ iata, lat, lon }) => [iata, anchors.reduce((best, anchor) => angle(lat, lon, anchor[1], anchor[2]) < angle(lat, lon, best[1], best[2]) ? anchor : best)[0]]).sort(([a], [b]) => a < b ? -1 : 1);
await writeFile(new URL('colo-locations.json', import.meta.url), '{\n' + lines.map(([iata, hint]) => '  "' + iata + '": "' + hint + '"').join(',\n') + '\n}\n');
