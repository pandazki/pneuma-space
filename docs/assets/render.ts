// Renders the README illustrations in both themes: node docs/assets/render.ts
import { writeFileSync } from 'node:fs';

const TOKENS = {
  light: {
    page: 'oklch(98.5% .001 286.376)', canvas: 'oklch(96.1% .002 247.84)', surface: 'oklch(100% 0 0)',
    inset: 'oklch(97.9% .002 247.839)', ink: 'oklch(24.7% .006 258.361)', ink2: 'oklch(50.6% .01 264.477)',
    ink3: 'oklch(69.5% .009 264.505)', line: 'oklch(94.6% .003 264.542)', lineStrong: 'oklch(91.2% .005 258.326)',
    lineSoft: 'oklch(96.6% .002 264.542)', stripe: 'oklch(40.5% 0 0 / .075)', stripeBg: 'oklch(97% 0 0)',
    accent: 'oklch(62.6% .205 254.947)', accentInk: 'oklch(55.6% .187 255.617)', accentTint: 'oklch(96% .019 252.878)',
    green: 'oklch(60.3% .155 150.883)', greenTint: 'oklch(95.8% .017 159.118)',
    orange: 'oklch(68.9% .179 49.902)', orangeTint: 'oklch(96.4% .021 67.581)',
  },
  dark: {
    page: 'oklch(20.9% .004 264.477)', canvas: 'oklch(23.1% .004 264.487)', surface: 'oklch(26% .006 271.191)',
    inset: 'oklch(24.3% .004 264.492)', ink: 'oklch(96.4% .002 247.839)', ink2: 'oklch(73.1% .008 260.731)',
    ink3: 'oklch(54.1% .01 264.484)', line: 'oklch(30.8% .006 258.354)', lineStrong: 'oklch(35.6% .007 264.474)',
    lineSoft: 'oklch(27.8% .006 258.354)', stripe: 'oklch(100% 0 0 / .055)', stripeBg: 'oklch(22.6% .004 264.485)',
    accent: 'oklch(68% .173 253.301)', accentInk: 'oklch(78.8% .113 248.33)', accentTint: 'oklch(68% .173 253.301 / .16)',
    green: 'oklch(70.5% .154 153.814)', greenTint: 'oklch(70.5% .154 153.814 / .14)',
    orange: 'oklch(74.6% .156 55.642)', orangeTint: 'oklch(74.6% .156 55.642 / .14)',
  },
};
type Theme = keyof typeof TOKENS;
type Palette = Record<keyof typeof TOKENS.light, string>;

// SVG presentation attributes and older renderers reject oklch(), so tokens become sRGB hex.
function hex(oklch: string): string {
  const [, l, c, h, a] = oklch.match(/oklch\(([\d.]+)% ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/)!;
  const L = Number(l) / 100, rad = (Number(h) * Math.PI) / 180;
  const A = Number(c) * Math.cos(rad), B = Number(c) * Math.sin(rad);
  const lc = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const mc = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const sc = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const linear = [
    4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc,
    -1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc,
    -0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc,
  ];
  const byte = (x: number) => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  };
  const alpha = a === undefined ? '' : Math.round(Number(a) * 255).toString(16).padStart(2, '0');
  return '#' + linear.map(byte).join('') + alpha;
}

const SANS = `ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'PingFang SC',sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const monoWidth = (s: string, size: number) => s.length * size * 0.6;

type Stop = [seconds: number, css: string];

class Scene {
  readonly css: string[] = [];
  readonly body: string[] = [];
  readonly c: Palette;
  readonly period: number;
  #n = 0;
  constructor(c: Palette, period: number) {
    this.c = c;
    this.period = period;
  }

  anim(stops: Stop[], ease = 'ease-in-out'): string {
    const name = 'k' + (this.#n++).toString(36);
    const frames = stops.map(([t, css]) => `${+((t / this.period) * 100).toFixed(2)}%{${css}}`).join('');
    this.css.push(`@keyframes ${name}{${frames}}.${name}{animation:${name} ${this.period}s ${ease} infinite both}`);
    return name;
  }

  // Visible from `on` to `off`, hidden otherwise; `to` is the shown value.
  show(on: number, off: number, to = 1, fade = 0.25): string {
    return this.anim([[0, `opacity:0`], [on, `opacity:0`], [on + fade, `opacity:${to}`], [off, `opacity:${to}`], [Math.min(off + fade, this.period), `opacity:0`], [this.period, `opacity:0`]]);
  }

  move(points: Array<[number, number]>, start: number, end: number): string {
    const step = (end - start) / (points.length - 1);
    const at = (i: number) => `transform:translate(${points[i][0]}px,${points[i][1]}px)`;
    const stops: Stop[] = [[0, `opacity:0;${at(0)}`], [start - 0.01, `opacity:0;${at(0)}`], [start, `opacity:1;${at(0)}`]];
    points.forEach((_, i) => i > 0 && stops.push([start + i * step, `opacity:1;${at(i)}`]));
    stops.push([end + 0.12, `opacity:0;${at(points.length - 1)}`], [this.period, `opacity:0;${at(points.length - 1)}`]);
    return this.anim(stops, 'linear');
  }

  add(...parts: string[]) { this.body.push(...parts); }

  text(x: number, y: number, s: string, o: { size?: number; fill?: string; weight?: number; mono?: boolean; anchor?: string; cls?: string; opacity?: number } = {}) {
    const attrs = [`x="${x}"`, `y="${y}"`, `font-size="${o.size ?? 12}"`, `fill="${o.fill ?? this.c.ink}"`];
    if (o.weight) attrs.push(`font-weight="${o.weight}"`);
    if (o.anchor) attrs.push(`text-anchor="${o.anchor}"`);
    if (o.opacity !== undefined) attrs.push(`opacity="${o.opacity}"`);
    attrs.push(`class="${[o.mono ? 'm' : 's', o.cls].filter(Boolean).join(' ')}"`);
    return `<text ${attrs.join(' ')}>${esc(s)}</text>`;
  }

  rect(x: number, y: number, w: number, h: number, o: { r?: number; fill?: string; stroke?: string; dash?: boolean; cls?: string; opacity?: number } = {}) {
    const attrs = [`x="${x}"`, `y="${y}"`, `width="${w}"`, `height="${h}"`, `rx="${o.r ?? 0}"`, `fill="${o.fill ?? 'none'}"`];
    if (o.stroke) attrs.push(`stroke="${o.stroke}"`);
    if (o.dash) attrs.push(`stroke-dasharray="4 3"`);
    if (o.cls) attrs.push(`class="${o.cls}"`);
    if (o.opacity !== undefined) attrs.push(`opacity="${o.opacity}"`);
    return `<rect ${attrs.join(' ')}/>`;
  }

  chip(x: number, y: number, label: string, o: { size?: number; fill?: string; ink?: string; cls?: string; opacity?: number } = {}) {
    const size = o.size ?? 11;
    const w = monoWidth(label, size) + 14;
    const g = `<g${o.cls ? ` class="${o.cls}"` : ''}${o.opacity !== undefined ? ` opacity="${o.opacity}"` : ''}>` +
      this.rect(x, y, w, 22, { r: 6, fill: o.fill ?? this.c.inset, stroke: o.fill ? undefined : this.c.line }) +
      this.text(x + 7, y + 15, label, { size, mono: true, fill: o.ink ?? this.c.ink2 }) + `</g>`;
    return { svg: g, w };
  }

  dot(cx: number, cy: number, fill: string, cls?: string, r = 3) {
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"${cls ? ` class="${cls}"` : ''}/>`;
  }

  packet(cls: string, fill = this.c.accent) {
    return `<g class="${cls}" opacity="0"><circle r="7" fill="${fill}" opacity=".18"/><circle r="3.5" fill="${fill}"/></g>`;
  }

  header(index: string, title: string, description: string) {
    this.add(
      this.text(28, 40, index, { size: 11, mono: true, fill: this.c.ink3 }),
      this.text(50, 40, title, { size: 13, weight: 600 }),
      this.text(28, 60, description, { size: 12.5, fill: this.c.ink3 }),
    );
  }

  svg(w: number, h: number, label: string, title: string) {
    const c = this.c;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" role="img" aria-label="${esc(label)}">` +
      `<title>${esc(title)}</title>` +
      `<style>.s{font-family:${SANS};letter-spacing:-.01em}.m{font-family:${MONO};font-variant-numeric:tabular-nums}text{white-space:pre}` +
      `${this.css.join('')}@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>` +
      `<defs><pattern id="stripe" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
      `<rect width="8" height="8" fill="${c.stripeBg}"/><rect width="1" height="8" fill="${c.stripe}"/></pattern></defs>` +
      `<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="16" fill="${c.page}" stroke="${c.line}"/>` +
      this.body.join('') + `</svg>`;
  }
}

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hero(c: Palette) {
  const W = 880, H = 300;
  const s = new Scene(c, 12);
  const gx = 452, gy = 24, gw = 404, gh = 226;
  s.add(s.rect(gx, gy, gw, gh, { r: 12, fill: 'url(#stripe)', stroke: c.line }));

  const tile = 11, gap = 5, cols = 24, rows = 13;
  const ox = gx + (gw - (cols * (tile + gap) - gap)) / 2, oy = gy + 14;
  const rand = rng(7);
  const visit = (period: number) => s.anim([
    [0, `fill:${c.lineStrong};transform:scale(1)`], [period * 0.55, `fill:${c.lineStrong};transform:scale(1)`], [period * 0.57, `fill:${c.orange};transform:scale(1.2)`],
    [period * 0.62, `fill:${c.orange};transform:scale(1)`], [period * 0.64, `fill:${c.green}`], [period * 0.86, `fill:${c.green}`],
    [period * 0.9, `fill:${c.lineStrong}`], [period, `fill:${c.lineStrong}`],
  ]);
  const staticHit = s.anim([[0, `fill:${c.lineStrong}`], [10.6, `fill:${c.lineStrong}`], [10.8, `fill:${c.accent}`], [11.4, `fill:${c.accent}`], [11.9, `fill:${c.lineStrong}`], [12, `fill:${c.lineStrong}`]]);
  const visits = [visit(12)];
  s.css.push(`rect.${visits[0]}{transform-box:fill-box;transform-origin:center}`);
  const tiles: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const x = ox + col * (tile + gap), y = oy + r * (tile + gap), roll = rand();
      let fill = c.lineStrong, cls = '', delay = '';
      if (roll < 0.012) fill = c.green;
      else if (roll < 0.3) { cls = visits[0]; delay = `animation-delay:-${(rand() * 12).toFixed(2)}s`; }
      else if (roll < 0.37) { cls = staticHit; delay = `animation-delay:-${(rand() * 12).toFixed(2)}s`; }
      tiles.push(`<rect x="${x}" y="${y}" width="${tile}" height="${tile}" rx="3" fill="${fill}"${cls ? ` class="${cls}" style="${delay}"` : ''}/>`);
    }
  }
  s.add(...tiles);

  let lx = gx + 2;
  const legend: Array<[string, string]> = [[c.green, 'awake'], [c.orange, 'waking'], [c.accent, 'static, no wake'], [c.lineStrong, 'asleep, data kept']];
  for (const [fill, label] of legend) {
    s.add(`<rect x="${lx}" y="${gy + gh + 12}" width="8" height="8" rx="2" fill="${fill}"/>`, s.text(lx + 13, gy + gh + 20, label, { size: 11, fill: c.ink3 }));
    lx += 28 + label.length * 5.6;
  }

  s.add(
    s.text(36, 92, 'PneumaSpace', { size: 36, weight: 600 }),
    s.text(36, 126, 'Stateful web apps on one machine you own.', { size: 16, fill: c.ink2 }),
    s.text(36, 158, 'An app declares what it needs. The platform provides it,', { size: 13, fill: c.ink3 }),
    s.text(36, 177, 'wakes the app on demand and lets it sleep when idle.', { size: 13, fill: c.ink3 }),
  );
  let cx = 36, cy = 200;
  for (const kind of ['files', 'db', 'kv', 'object', 'static', 'ws', 'cron', 'identity', 'rtc']) {
    const w = monoWidth(kind, 11) + 14;
    if (cx + w > 420) { cx = 36; cy += 28; }
    s.add(s.chip(cx, cy, kind).svg);
    cx += w + 6;
  }
  const cmd = '$ docker compose up -d';
  s.add(s.rect(36, 260, monoWidth(cmd, 11.5) + 20, 24, { r: 12, fill: c.canvas, stroke: c.line }), s.text(46, 276, cmd, { size: 11.5, mono: true, fill: c.ink2 }));
  return s.svg(W, H,
    'PneumaSpace: stateful web apps on one machine you own. A grid of hundreds of apps, most of them asleep; now and then one wakes on a request, turns orange, then green, and goes back to sleep, while static hits flash blue without waking anything.',
    'PneumaSpace');
}

function mount(c: Palette) {
  const W = 880, H = 464, T = 16;
  const s = new Scene(c, T);
  s.header('01', 'How a capability is mounted', 'Declared once in the manifest, provisioned by its Provider at publish, injected when the container is created.');

  const phases = [['publish', 'Provider.ensure', 0.3, 6.2, 28], ['wake', 'Provider.inject → RunSpec', 6.2, 10.8, 316], ['run', 'the SDK reads PNEUMA_SPACE_*', 10.8, 15.4, 586]] as const;
  phases.forEach(([name, what, on, off, x], i) => {
    s.add(
      `<circle cx="${x + 9}" cy="92" r="9" fill="${c.canvas}" stroke="${c.lineStrong}"/>`,
      s.text(x + 9, 96, String(i + 1), { size: 10.5, mono: true, anchor: 'middle', fill: c.ink2 }),
      `<g class="${s.show(on, off)}" opacity="0"><circle cx="${x + 9}" cy="92" r="9" fill="${c.accent}"/>${s.text(x + 9, 96, String(i + 1), { size: 10.5, mono: true, anchor: 'middle', fill: '#ffffff' })}</g>`,
      s.text(x + 24, 96, name, { size: 12.5, weight: 600 }),
      s.text(x + 32 + name.length * 7.6, 96, what, { size: 11.5, mono: true, fill: c.ink3 }),
    );
  });

  const mx = 28, my = 116, mw = 196;
  const lines = ['{ "contract": 1,', '  "capabilities": {', '    "files":  {},', '    "db":     {},', '    "kv":     {},', '    "object": {},', '    "ws":     {}', '} }'];
  s.add(s.rect(mx, my, mw, 212, { r: 14, fill: c.canvas, stroke: c.line }), s.text(mx + 14, my + 22, 'pneuma-space.json', { size: 11.5, mono: true, fill: c.ink3 }));
  const lineY = (i: number) => my + 50 + i * 20;
  const lineText = lines.map((l, i) => s.text(mx + 14, lineY(i), l, { size: 11.5, mono: true, fill: c.ink2 }));

  const kinds = [
    { kind: 'files', provider: 'volume', resource: 'pneuma-space-files-<id>', inject: [0, 2] },
    { kind: 'db', provider: 'sqlite | postgres', resource: 'pneuma-space-db-<id> | app_<id>', inject: [1, 3] },
    { kind: 'kv', provider: 'redis', resource: 'ACL user app_<id>, keys <id>:*', inject: [4, 5] },
    { kind: 'object', provider: 's3', resource: 'bucket app-<id>, its own key', inject: [6] },
  ];
  const px = 256, pw = 282, rowY = (i: number) => 120 + i * 48;
  const cxl = 566, cw = 290, cy0 = 116;
  const runLines = [
    ['mount', '/data      ← pneuma-space-files-<id>'],
    ['mount', '/pneuma/db ← pneuma-space-db-<id>'],
    ['env', 'PNEUMA_SPACE_FILES_DIR=/data'],
    ['env', 'PNEUMA_SPACE_DB_URL=sqlite:///pneuma/…'],
    ['env', 'PNEUMA_SPACE_KV_URL=redis://app_<id>:…'],
    ['env', 'PNEUMA_SPACE_KV_PREFIX=<id>:'],
    ['env', 'PNEUMA_SPACE_OBJECT_BUCKET=app-<id> …'],
  ];
  const runY = (i: number) => cy0 + 80 + i * 19 + (i >= 2 ? 22 : 0);

  const containerOn = 6.4;
  s.add(
    s.rect(cxl, cy0, cw, 286, { r: 14, fill: c.surface, stroke: c.lineStrong, dash: true }),
    s.rect(cxl, cy0, cw, 286, { r: 14, stroke: c.accent, cls: s.show(containerOn, T - 0.6) , opacity: 0 }),
    s.text(cxl + 14, cy0 + 22, 'container', { size: 11.5, fill: c.ink3 }),
    s.text(cxl + 14, cy0 + 42, 'pneuma-space-<id>-<release>', { size: 11.5, mono: true, fill: c.ink, cls: s.show(containerOn, T - 0.6) }),
    s.text(cxl + 14, cy0 + 42, 'not created while asleep', { size: 11.5, fill: c.ink3, opacity: 0, cls: s.anim([[0, 'opacity:1'], [containerOn, 'opacity:1'], [containerOn + 0.2, 'opacity:0'], [T - 0.4, 'opacity:0'], [T, 'opacity:1']]) }),
  );

  kinds.forEach((k, i) => {
    const t0 = 0.8 + i * 1.15, t1 = 6.8 + i * 0.95;
    const ly = lineY(2 + i), ry = rowY(i);
    s.add(s.rect(mx + 8, ly - 14, mw - 16, 19, { r: 5, fill: c.accentTint, cls: s.anim([[0, 'opacity:0'], [t0, 'opacity:0'], [t0 + 0.2, 'opacity:1'], [t0 + 1, 'opacity:1'], [t0 + 1.3, 'opacity:.45'], [T - 0.6, 'opacity:.45'], [T - 0.3, 'opacity:0']]), opacity: 0 }));

    const curve = (x0: number, y0: number, x1: number, y1: number) => `M${x0},${y0} C${x0 + 24},${y0} ${x1 - 24},${y1} ${x1},${y1}`;
    const sample = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> =>
      [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => {
        const u = 1 - t;
        const x = u ** 3 * x0 + 3 * u * u * t * (x0 + 24) + 3 * u * t * t * (x1 - 24) + t ** 3 * x1;
        const y = u ** 3 * y0 + 3 * u * u * t * y0 + 3 * u * t * t * y1 + t ** 3 * y1;
        return [+x.toFixed(1), +y.toFixed(1)];
      });
    const a = [mx + mw, ly - 4, px, ry + 20] as const;
    s.add(`<path d="${curve(...a)}" stroke="${c.lineStrong}"/>`);
    s.add(`<path d="${curve(...a)}" stroke="${c.accent}" class="${s.show(t0, t0 + 0.9)}" opacity="0"/>`, s.packet(s.move(sample(...a), t0 + 0.1, t0 + 0.7)));

    const active = s.anim([[0, 'opacity:0'], [t0 + 0.9, 'opacity:0'], [t0 + 1.1, 'opacity:1'], [T - 0.6, 'opacity:1'], [T - 0.3, 'opacity:0']]);
    s.add(
      s.rect(px, ry, pw, 40, { r: 10, fill: c.surface, stroke: c.line }),
      s.chip(px + 8, ry + 9, k.kind, { size: 10.5 }).svg,
      s.text(px + 22 + monoWidth(k.kind, 10.5) + 8, ry + 17, k.provider, { size: 11, mono: true, fill: c.ink3 }),
      s.text(px + 22 + monoWidth(k.kind, 10.5) + 8, ry + 32, k.resource, { size: 10.5, mono: true, fill: c.ink2, cls: active }),
      s.dot(px + pw - 54, ry + 13, c.ink3, undefined, 3),
      s.text(px + pw - 46, ry + 17, 'none', { size: 11, fill: c.ink3, opacity: 0, cls: s.anim([[0, 'opacity:1'], [t0 + 0.6, 'opacity:1'], [t0 + 0.7, 'opacity:0'], [T - 0.3, 'opacity:0'], [T, 'opacity:1']]) }),
      `<g class="${s.show(t0 + 0.6, t0 + 1)}" opacity="0">${s.dot(px + pw - 54, ry + 13, c.orange)}${s.text(px + pw - 46, ry + 17, 'ensure', { size: 11, fill: c.orange })}</g>`,
      `<g class="${active}">${s.dot(px + pw - 54, ry + 13, c.green)}${s.text(px + pw - 46, ry + 17, 'active', { size: 11, fill: c.green })}</g>`,
    );

    const target = runY(k.inject[0]);
    const b = [px + pw, ry + 20, cxl, target - 4] as const;
    s.add(`<path d="${curve(...b)}" stroke="${c.lineStrong}"/>`);
    s.add(`<path d="${curve(...b)}" stroke="${c.accent}" class="${s.show(t1, t1 + 0.8)}" opacity="0"/>`, s.packet(s.move(sample(...b), t1, t1 + 0.6)));
    for (const j of k.inject) {
      const [section, value] = runLines[j];
      s.add(s.text(cxl + 14, runY(j), value, { size: 10.5, mono: true, fill: section === 'mount' ? c.accentInk : c.ink2, cls: s.anim([[0, 'opacity:0'], [t1 + 0.6, 'opacity:0'], [t1 + 0.8, 'opacity:1'], [T - 0.6, 'opacity:1'], [T - 0.3, 'opacity:0']]) }));
    }
  });

  s.add(
    s.text(cxl + 14, runY(0) - 16, 'mounts', { size: 11, fill: c.ink3 }),
    s.text(cxl + 14, runY(2) - 16, 'environment', { size: 11, fill: c.ink3 }),
  );

  const wy = rowY(4);
  s.add(
    s.rect(px, wy, pw, 40, { r: 10, stroke: c.lineStrong, dash: true }),
    s.chip(px + 8, wy + 9, 'ws', { size: 10.5 }).svg,
    s.text(px + 48, wy + 17, 'no Provider', { size: 11, mono: true, fill: c.ink3 }),
    s.text(px + 48, wy + 32, 'the gateway passes upgrades through', { size: 11, fill: c.ink3 }),
  );
  const tw = 5.4, wly = lineY(6);
  const wa = [mx + mw, wly - 4, px, wy + 20] as const;
  s.add(
    `<path d="M${wa[0]},${wa[1]} C${wa[0] + 24},${wa[1]} ${wa[2] - 24},${wa[3]} ${wa[2]},${wa[3]}" stroke="${c.lineStrong}" stroke-dasharray="3 3"/>`,
    s.rect(mx + 8, wly - 14, mw - 16, 19, { r: 5, fill: c.lineSoft, cls: s.show(tw, T - 0.6, 1), opacity: 0 }),
  );

  s.add(...lineText);

  const sdk = ["need('files')", 'db()', 'kv()', 'objects()'];
  let sx = cxl + 14;
  s.add(s.text(cxl + 14, cy0 + 244, 'sdk', { size: 11, fill: c.ink3 }));
  sdk.forEach((call, i) => {
    const on = 11 + i * 0.5;
    const idle = s.chip(sx, cy0 + 254, call, { size: 10.5 });
    s.add(idle.svg, s.chip(sx, cy0 + 254, call, { size: 10.5, fill: c.accentTint, ink: c.accentInk, cls: s.anim([[0, 'opacity:0'], [on, 'opacity:0'], [on + 0.25, 'opacity:1'], [T - 0.6, 'opacity:1'], [T - 0.3, 'opacity:0']]), opacity: 0 }).svg);
    sx += idle.w + 6;
  });

  s.add(
    s.text(28, 424, 'ensure runs on every publish and is safe to repeat; on a suspended binding it is the resume.', { size: 12, fill: c.ink2 }),
    s.text(28, 444, 'remove suspends every binding and keeps the data. Only purge destroys, and only after remove.', { size: 12, fill: c.ink3 }),
  );
  return s.svg(W, H,
    'How a capability is mounted. The manifest declares files, db, kv, object and ws. At publish each resource kind goes to its Provider, whose ensure creates a volume, a database, a Redis ACL user limited to the app key prefix, and a bucket with its own key, and marks the binding active; ws has no Provider, the gateway handles it. When the app wakes, inject turns each binding into mounts and PNEUMA_SPACE environment variables on the container, and the SDK reads them.',
    'How a capability is mounted');
}

function gateway(c: Palette) {
  const W = 880, H = 500, T = 20;
  const s = new Scene(c, T);
  s.header('02', 'One gateway, every app on its own resources', 'Every request enters through the same gateway. Each app keeps its own volume, database, key prefix and bucket.');

  const gx = 184, gw = 208, gy = 104, gh = 224;
  const cols = { app: 412, instance: 484, files: 562, db: 644, kv: 714, object: 780, end: 860 };
  const rows = { docs: 160, survey: 208, ttt: 256, widget: 304, album: 360 };
  const header = (x: number, label: string) => s.text(x + 6, 98, label, { size: 11, fill: c.ink3 });
  s.add(header(20, 'callers'), header(gx, 'gateway :8080'), header(cols.app, 'app'), header(cols.instance, 'instance'),
    header(cols.files, 'files'), header(cols.db, 'db'), header(cols.kv, 'kv'), header(cols.object, 'object'));

  const services: Array<[number, number, string, string]> = [
    [gx, cols.app - 20 - gx, 'bundle store', 'static bytes, in RustFS'],
    [cols.instance, cols.files - cols.instance, 'Docker', 'containers'],
    [cols.files, cols.db - cols.files, 'volumes', 'named'],
    [cols.db, cols.kv - cols.db, 'SQLite', 'or Postgres'],
    [cols.kv, cols.object - cols.kv, 'Redis', 'ACL users'],
    [cols.object, cols.end - cols.object, 'RustFS', 'buckets'],
  ];
  const sy = 402;
  for (const [x, w, name, detail] of services) {
    if (x !== gx && x !== cols.instance) s.add(`<path d="M${x + w / 2},${gy + 8} V${sy}" stroke="${c.line}" stroke-dasharray="2 4"/>`);
  }
  const serviceBox: Record<string, string> = {};
  for (const [x, w, name, detail] of services) {
    s.add(s.rect(x + 3, sy, w - 6, 40, { r: 8, fill: 'url(#stripe)', stroke: c.line }), s.text(x + 9, sy + 17, name, { size: 11, weight: 600, fill: c.ink2 }), s.text(x + 9, sy + 32, detail, { size: 10, fill: c.ink3 }));
    serviceBox[name] = `${x + 3},${w - 6}`;
  }

  s.add(s.rect(gx, gy, gw, gh, { r: 14, fill: c.surface, stroke: c.lineStrong }), s.text(gx + 12, gy + 18, 'route · strip X-Pneuma-Space-*', { size: 10, mono: true, fill: c.ink3 }),
    s.text(gx + 12, gy + gh - 14, 'acquire → wake · metrics → :8081', { size: 10, mono: true, fill: c.ink3 }));
  for (const y of Object.values(rows)) s.add(`<path d="M${cols.app},${y + 22} H${cols.end}" stroke="${c.line}"/>`);

  type Row = keyof typeof rows;
  const ids: Record<Row, string> = { docs: '5d44', survey: '3f9a', ttt: '7c2e', widget: 'e90b', album: 'b1c8' };
  const names: Record<Row, string> = { docs: 'site-docs', survey: 'survey', ttt: 'ttt', widget: 'widget', album: 'album' };
  const declared: Record<Row, Array<'files' | 'db' | 'kv' | 'object'>> = { docs: [], survey: ['files', 'db'], ttt: ['kv'], widget: ['db'], album: ['db', 'object'] };
  const cellLabel = { files: (id: string) => `files-${id}…`, db: (id: string) => `db-${id}…`, kv: (id: string) => `${id}…:*`, object: (id: string) => `app-${id}…` };
  const cellX: Record<string, number> = {};
  const pulse: Record<string, number[]> = { 'survey.files': [4.5], 'survey.db': [4.7], 'ttt.kv': [8.6, 10.6, 12.6, 14.6], 'widget.db': [11.2], 'album.object': [13.9] };

  const awake: Record<Row, Array<[number, number, number]>> = { docs: [], survey: [[3, 4.2, 12.6]], ttt: [[6.2, 7.4, 17.2]], widget: [[9.4, 10.6, 14.4]], album: [] };
  for (const row of Object.keys(rows) as Row[]) {
    const y = rows[row];
    for (const [, up, down] of awake[row]) s.add(s.rect(cols.app, y - 18, cols.end - cols.app, 38, { r: 8, fill: c.greenTint, cls: s.show(up, down, 1, 0.3), opacity: 0 }));
    s.add(s.text(cols.app + 6, y - 1, names[row], { size: 11.5, mono: true }), s.text(cols.app + 6, y + 13, ids[row] + '…', { size: 10, mono: true, fill: c.ink3 }));
    for (const kind of ['files', 'db', 'kv', 'object'] as const) {
      const x = cols[kind] + 4;
      if (!declared[row].includes(kind)) { s.add(s.text(x + 6, y + 4, '·', { size: 11, fill: c.ink3 })); continue; }
      const chip = s.chip(x, y - 11, cellLabel[kind](ids[row]), { size: 10 });
      s.add(chip.svg);
      for (const t of pulse[`${row}.${kind}`] ?? []) {
        s.add(s.chip(x, y - 11, cellLabel[kind](ids[row]), { size: 10, fill: c.accentTint, ink: c.accentInk, cls: s.show(t, t + 0.7, 1, 0.15), opacity: 0 }).svg);
      }
      cellX[`${row}.${kind}`] = x + chip.w / 2;
    }
    const ix = cols.instance + 6;
    if (row === 'docs') { s.add(s.text(ix, y + 4, 'no container', { size: 11, fill: c.ink3 })); continue; }
    const asleepWindows = awake[row];
    const asleepStops: Stop[] = [[0, 'opacity:1']];
    for (const [wake, , down] of asleepWindows) asleepStops.push([wake, 'opacity:1'], [wake + 0.15, 'opacity:0'], [down, 'opacity:0'], [down + 0.15, 'opacity:1']);
    asleepStops.push([T, 'opacity:1']);
    s.add(`<g class="${s.anim(asleepStops)}">${s.dot(ix + 3, y, c.ink3)}${s.text(ix + 11, y + 4, 'asleep', { size: 11.5, fill: c.ink3 })}</g>`);
    for (const [wake, up, down] of asleepWindows) {
      s.add(
        `<g class="${s.show(wake, up - 0.15, 1, 0.15)}" opacity="0">${s.dot(ix + 3, y, c.orange)}${s.text(ix + 11, y + 4, 'waking', { size: 11.5, fill: c.orange })}</g>`,
        `<g class="${s.show(up, down, 1, 0.15)}" opacity="0">${s.dot(ix + 3, y, c.green)}${s.text(ix + 11, y + 4, 'awake', { size: 11.5, fill: c.green })}</g>`,
      );
    }
  }

  const caller = (y: number, label: string, icon: string) => {
    s.add(s.rect(20, y - 13, 150, 26, { r: 13, fill: c.surface, stroke: c.line }), icon, s.text(44, y + 4, label, { size: 10, mono: true, fill: c.ink2 }));
  };
  const globe = (y: number) => `<g stroke="${c.ink3}" stroke-width="1.2"><circle cx="33" cy="${y}" r="6"/><path d="M27,${y} H39 M33,${y - 6} C30,${y - 3} 30,${y + 3} 33,${y + 6} M33,${y - 6} C36,${y - 3} 36,${y + 3} 33,${y + 6}"/></g>`;
  const clock = (y: number) => `<g stroke="${c.ink3}" stroke-width="1.2"><circle cx="33" cy="${y}" r="6"/><path d="M33,${y - 3.5} V${y} L35.5,${y + 2}"/></g>`;
  caller(rows.docs, 'GET /apps/site-docs/', globe(rows.docs));
  caller(rows.survey, 'GET /apps/survey/', globe(rows.survey));
  caller(rows.ttt, 'WS  /apps/ttt/ws', globe(rows.ttt));
  caller(rows.widget, "cron 'refresh'", clock(rows.widget));
  caller(rows.album, 'PUT presigned URL', globe(rows.album));

  const lane = (y: number) => `M170,${y} H${gx} M${gx + gw},${y} H${cols.app - 6}`;
  for (const row of ['survey', 'ttt', 'widget'] as Row[]) s.add(`<path d="${lane(rows[row])}" stroke="${c.lineStrong}"/>`);
  s.add(`<path d="M170,${rows.docs} H${gx}" stroke="${c.lineStrong}"/>`);

  const tag = (y: number, label: string, on: number, off: number, tone = c.accentInk, fill = c.accentTint) => {
    const w = monoWidth(label, 10) + 14;
    s.add(`<g class="${s.show(on, off)}" opacity="0">${s.rect(gx + gw / 2 - w / 2, y - 26, w, 18, { r: 9, fill })}${s.text(gx + gw / 2, y - 13, label, { size: 10, mono: true, anchor: 'middle', fill: tone })}</g>`);
  };

  s.add(s.packet(s.move([[170, rows.docs], [gx + 110, rows.docs]], 0.4, 1.0)), s.packet(s.move([[gx + 110, rows.docs], [170, rows.docs]], 1.4, 2.0), c.green));
  tag(rows.docs, 'bundle hit → 200, no wake', 1.0, 3.4, c.accentInk);

  s.add(s.packet(s.move([[170, rows.survey], [gx + 104, rows.survey], [cols.app - 6, rows.survey]], 2.0, 3.0)));
  tag(rows.survey, 'login → X-Pneuma-Space-Subject', 2.5, 5.6);
  s.add(s.packet(s.move([[cols.app - 6, rows.survey], [170, rows.survey]], 5.0, 5.8), c.green));

  s.add(s.packet(s.move([[170, rows.ttt], [gx + 104, rows.ttt], [cols.app - 6, rows.ttt]], 5.2, 6.2)));
  tag(rows.ttt, 'upgrade → channel lease', 5.7, 9.2);
  s.add(`<path d="M170,${rows.ttt} H${cols.app - 6}" stroke="${c.accent}" stroke-width="2" stroke-dasharray="6 4" class="${s.show(7.4, 16.6)}" opacity="0"/>`);

  s.add(s.packet(s.move([[170, rows.widget], [gx + 104, rows.widget], [cols.app - 6, rows.widget]], 8.4, 9.4)));
  tag(rows.widget, 'schedule → trigger lease', 8.9, 12.4);

  const [rx] = serviceBox['RustFS'].split(',').map(Number);
  const bucket = cellX['album.object'];
  s.add(`<path d="M170,${rows.album} H176 Q184,${rows.album} 184,${rows.album + 8} V${rows.album + 22} Q184,${rows.album + 30} 192,${rows.album + 30} H${bucket - 8} Q${bucket},${rows.album + 30} ${bucket},${rows.album + 38} V${sy}" stroke="${c.lineStrong}" stroke-dasharray="4 4"/>`);
  s.add(s.text(gx + 14, rows.album + 4, 'object bytes skip the gateway', { size: 10.5, fill: c.ink3 }));
  s.add(s.packet(s.move([[170, rows.album], [184, rows.album + 14], [192, rows.album + 30], [bucket, rows.album + 30], [bucket, sy + 6]], 12.4, 13.8)));
  s.add(s.rect(rx, sy, cols.end - cols.object - 6, 40, { r: 8, stroke: c.accent, cls: s.show(13.8, 14.8, 0.9, 0.15), opacity: 0 }));

  s.add(
    s.text(20, 470, 'Names are namespaced per app on one trusted host, so apps never trample each other.', { size: 12, fill: c.ink2 }),
    s.text(20, 488, 'This is not tenant isolation: containers share one network and the operator trusts every image.', { size: 12, fill: c.ink3 }),
  );
  return s.svg(W, H,
    'One gateway, each app on its own resources. Requests for five apps enter one gateway. A static page is served from the bundle store without waking anything. A browser request to survey passes the login, gets a subject header, wakes the survey container, touches its own volume and database, and survey later sleeps when idle. A WebSocket to ttt wakes it and keeps it awake while the socket is open, using its own Redis key prefix. A cron trigger wakes widget. A presigned upload goes straight from the browser to the album bucket in RustFS without passing the gateway, and album stays asleep. Shared services underneath, Docker, volumes, SQLite or Postgres, Redis and RustFS, are partitioned per app by name; this is namespacing on one trusted host, not tenant isolation.',
    'One gateway, each app on its own resources');
}

const scenes = { hero, mount, gateway };
const dir = new URL('.', import.meta.url);
for (const [name, render] of Object.entries(scenes)) {
  for (const theme of Object.keys(TOKENS) as Theme[]) {
    const palette = Object.fromEntries(Object.entries(TOKENS[theme]).map(([k, v]) => [k, hex(v)])) as Palette;
    writeFileSync(new URL(`${name}-${theme}.svg`, dir), render(palette));
  }
}
