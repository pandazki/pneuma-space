// Renders the README scenes in both themes: node docs/assets/render.ts
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
    red: 'oklch(62.1% .192 23.042)', redTint: 'oklch(95.6% .017 17.462)',
  },
  dark: {
    page: 'oklch(20.9% .004 264.477)', canvas: 'oklch(23.1% .004 264.487)', surface: 'oklch(26% .006 271.191)',
    inset: 'oklch(24.3% .004 264.492)', ink: 'oklch(96.4% .002 247.839)', ink2: 'oklch(73.1% .008 260.731)',
    ink3: 'oklch(54.1% .01 264.484)', line: 'oklch(30.8% .006 258.354)', lineStrong: 'oklch(35.6% .007 264.474)',
    lineSoft: 'oklch(27.8% .006 258.354)', stripe: 'oklch(100% 0 0 / .055)', stripeBg: 'oklch(22.6% .004 264.485)',
    accent: 'oklch(68% .173 253.301)', accentInk: 'oklch(78.8% .113 248.33)', accentTint: 'oklch(68% .173 253.301 / .16)',
    green: 'oklch(70.5% .154 153.814)', greenTint: 'oklch(70.5% .154 153.814 / .14)',
    orange: 'oklch(74.6% .156 55.642)', orangeTint: 'oklch(74.6% .156 55.642 / .14)',
    red: 'oklch(66.6% .18 21.433)', redTint: 'oklch(66.6% .18 21.433 / .14)',
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
type Pt = [number, number];
type Win = Array<[on: number, off: number]>;
type Edge = [x1: number, y1: number, x2: number, y2: number];

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

  // Shown inside each window, hidden outside it; `invert` swaps the two.
  windows(ws: Win, fade = 0.2, invert = false): string {
    const [out, inside] = invert ? [1, 0] : [0, 1];
    const stops: Stop[] = [[0, `opacity:${out}`]];
    for (const [on, off] of ws) {
      stops.push([on, `opacity:${out}`], [Math.min(on + fade, off), `opacity:${inside}`], [off, `opacity:${inside}`], [Math.min(off + fade, this.period), `opacity:${out}`]);
    }
    stops.push([this.period, `opacity:${out}`]);
    return this.anim(stops);
  }

  // `still` is what a reader with reduced motion sees, so every still frame reads on its own.
  layer(inner: string, ws: Win, still: boolean, fade?: number): string {
    return `<g class="${this.windows(ws, fade)}" opacity="${still ? 1 : 0}">${inner}</g>`;
  }

  unless(inner: string, ws: Win, still: boolean, fade?: number): string {
    return `<g class="${this.windows(ws, fade, true)}" opacity="${still ? 1 : 0}">${inner}</g>`;
  }

  // A packet travelling `points` at constant speed; returns the moment it passes each point.
  trip(points: Pt[], start: number, end: number, fill = this.c.accent): number[] {
    const dist = [0];
    for (let i = 1; i < points.length; i++) dist.push(dist[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    const times = dist.map((d) => start + (d / (dist.at(-1) || 1)) * (end - start));
    const at = (i: number) => `transform:translate(${points[i][0]}px,${points[i][1]}px)`;
    const stops: Stop[] = [[0, `opacity:0;${at(0)}`], [Math.max(0, start - 0.01), `opacity:0;${at(0)}`], [start, `opacity:1;${at(0)}`]];
    points.forEach((_, i) => i > 0 && stops.push([times[i], `opacity:1;${at(i)}`]));
    stops.push([Math.min(end + 0.12, this.period), `opacity:0;${at(points.length - 1)}`], [this.period, `opacity:0;${at(points.length - 1)}`]);
    const cls = this.anim(stops, 'linear');
    this.add(`<g class="${cls}" opacity="0"><circle r="7" fill="${fill}" opacity=".18"/><circle r="3.5" fill="${fill}"/></g>`);
    return times;
  }

  add(...parts: string[]) { this.body.push(...parts); }

  text(x: number, y: number, s: string, o: { size?: number; fill?: string; weight?: number; mono?: boolean; anchor?: string; opacity?: number } = {}) {
    const attrs = [`x="${x}"`, `y="${y}"`, `font-size="${o.size ?? 12}"`, `fill="${o.fill ?? this.c.ink}"`];
    if (o.weight) attrs.push(`font-weight="${o.weight}"`);
    if (o.anchor) attrs.push(`text-anchor="${o.anchor}"`);
    if (o.opacity !== undefined) attrs.push(`opacity="${o.opacity}"`);
    attrs.push(`class="${o.mono ? 'm' : 's'}"`);
    return `<text ${attrs.join(' ')}>${esc(s)}</text>`;
  }

  rect(x: number, y: number, w: number, h: number, o: { r?: number; fill?: string; stroke?: string; width?: number; dash?: string; cls?: string; opacity?: number } = {}) {
    const attrs = [`x="${x}"`, `y="${y}"`, `width="${w}"`, `height="${h}"`, `rx="${o.r ?? 0}"`, `fill="${o.fill ?? 'none'}"`];
    if (o.stroke) attrs.push(`stroke="${o.stroke}"`);
    if (o.width) attrs.push(`stroke-width="${o.width}"`);
    if (o.dash) attrs.push(`stroke-dasharray="${o.dash}"`);
    if (o.cls) attrs.push(`class="${o.cls}"`);
    if (o.opacity !== undefined) attrs.push(`opacity="${o.opacity}"`);
    return `<rect ${attrs.join(' ')}/>`;
  }

  path(d: string, stroke: string, o: { width?: number; dash?: string; cls?: string } = {}) {
    return `<path d="${d}" stroke="${stroke}"${o.width ? ` stroke-width="${o.width}"` : ''}${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}${o.cls ? ` class="${o.cls}"` : ''}/>`;
  }

  dot(cx: number, cy: number, fill: string, r = 3) {
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
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
      `@keyframes dash{to{stroke-dashoffset:-16}}.dash{animation:dash 1s linear infinite}` +
      `${this.css.join('')}@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>` +
      `<defs><pattern id="stripe" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
      `<rect width="8" height="8" fill="${c.stripeBg}"/><rect width="1" height="8" fill="${c.stripe}"/></pattern></defs>` +
      `<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="16" fill="${c.page}" stroke="${c.line}"/>` +
      this.body.join('') + `</svg>`;
  }
}

// The console's edge: a horizontal S from (x1, y1) to (x2, y2).
const curveD = (x1: number, y1: number, x2: number, y2: number) => {
  const dx = Math.max(24, (x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
};
function curvePts(x1: number, y1: number, x2: number, y2: number, n = 8): Pt[] {
  const dx = Math.max(24, (x2 - x1) / 2);
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, u = 1 - t;
    const x = u ** 3 * x1 + 3 * u * u * t * (x1 + dx) + 3 * u * t * t * (x2 - dx) + t ** 3 * x2;
    const y = u ** 3 * y1 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y2;
    return [+x.toFixed(1), +y.toFixed(1)] as Pt;
  });
}

// The console topology's vocabulary: app chips with a state dot, lane boxes on a hatched base, hatched service boxes, count labels on edges.

type Tone = 'asleep' | 'waking' | 'awake' | 'hit' | 'bad' | 'lit';
const tone = (c: Palette, t: Tone) => ({
  asleep: { fill: c.inset, stroke: c.line, dot: c.ink3, ink: c.ink2 },
  waking: { fill: c.orangeTint, stroke: c.orange, dot: c.orange, ink: c.ink },
  awake: { fill: c.greenTint, stroke: c.green, dot: c.green, ink: c.ink },
  hit: { fill: c.accentTint, stroke: c.accent, dot: c.accent, ink: c.ink },
  bad: { fill: c.redTint, stroke: c.red, dot: c.red, ink: c.red },
  lit: { fill: c.surface, stroke: c.accent, dot: c.ink3, ink: c.ink },
})[t];
const chipW = (name: string) => Math.max(56, monoWidth(name, 11) + 30);

function chip(s: Scene, x: number, y: number, name: string, t: Tone, w = chipW(name)) {
  const k = tone(s.c, t);
  return (t === 'asleep' ? '' : s.rect(x, y, w, 22, { r: 6, fill: s.c.surface })) +
    s.rect(x + 0.5, y + 0.5, w - 1, 21, { r: 6, fill: k.fill, stroke: k.stroke }) +
    s.dot(x + 10, y + 11, k.dot) + s.text(x + 19, y + 15, name, { size: 11, mono: true, fill: k.ink });
}

type App = { name: string; x: number; y: number; w?: number; states?: Partial<Record<Tone, Win>>; still?: Tone; shown?: Win };
function app(s: Scene, a: App) {
  const asleep = chip(s, a.x, a.y, a.name, 'asleep', a.w);
  s.add(a.shown ? s.layer(asleep, a.shown, true) : asleep);
  for (const [t, ws] of Object.entries(a.states ?? {}) as Array<[Tone, Win]>) s.add(s.layer(chip(s, a.x, a.y, a.name, t, a.w), ws, a.still === t, 0.15));
  return { cx: a.x + (a.w ?? chipW(a.name)) / 2, cy: a.y + 11, right: a.x + (a.w ?? chipW(a.name)) };
}

function lane(s: Scene, x: number, y: number, w: number, h: number, name: string, sub: string, engine: string, store: string) {
  const c = s.c, sy = y + h - 32;
  s.add(
    s.rect(x, y, w, h, { r: 14, fill: c.surface, stroke: c.line }),
    s.text(x + 12, y + 22, name, { size: 12.5, weight: 600 }),
    s.text(x + w - 12, y + 22, sub, { size: 11, fill: c.ink3, anchor: 'end' }),
    s.rect(x + 12, sy, w - 24, 24, { r: 8, fill: 'url(#stripe)', stroke: c.line }),
    s.text(x + 22, sy + 16, engine, { size: 11, weight: 600, fill: c.ink2 }),
  );
  if (store) s.add(s.text(x + w - 22, sy + 16, store, { size: 10, mono: true, fill: c.ink3, anchor: 'end' }));
  return sy;
}

function service(s: Scene, x: number, y: number, w: number, h: number, name: string, up: boolean, note: string, lit = false) {
  const c = s.c, status = up ? 'up' : 'off';
  return (
    s.rect(x, y, w, h, { r: 10, fill: 'url(#stripe)', stroke: lit ? c.accent : c.line, width: lit ? 1.5 : undefined }) +
    s.text(x + 12, y + 19, name, { size: 12, weight: 600, fill: up ? c.ink : c.ink2 }) +
    s.dot(x + w - 18 - status.length * 6, y + 15, up ? c.green : c.ink3) +
    s.text(x + w - 12, y + 19, status, { size: 11, fill: up ? c.green : c.ink3, anchor: 'end' }) +
    s.text(x + 12, y + 34, note, { size: 10.5, fill: c.ink3 })
  );
}

function edgeLabel(s: Scene, x: number, y: number, label: string, lit = false) {
  const c = s.c;
  return s.rect(x, y - 8, monoWidth(label, 10) + 10, 16, { r: 5, fill: lit ? c.accentTint : c.surface, stroke: lit ? c.accent : c.line }) +
    s.text(x + 5, y + 3.5, label, { size: 10, mono: true, fill: lit ? c.accentInk : c.ink2 });
}

function pill(s: Scene, x: number, y: number, label: string, fill: string, ink: string) {
  return s.rect(x, y, monoWidth(label, 10) + 14, 18, { r: 9, fill }) + s.text(x + 7, y + 12.5, label, { size: 10, mono: true, fill: ink });
}

function caller(s: Scene, x: number, cy: number, w: number, label: string, lit = false) {
  const c = s.c;
  return s.rect(x, cy - 14, w, 28, { r: 14, fill: c.surface, stroke: lit ? c.accent : c.line }) +
    `<circle cx="${x + 16}" cy="${cy}" r="5.5" stroke="${lit ? c.accent : c.ink3}" stroke-width="1.2"/>` +
    s.text(x + 28, cy + 4, label, { size: 11.5 });
}

function hero(c: Palette) {
  const W = 880, H = 536, T = 28, END = 27.4;
  const s = new Scene(c, T);
  s.add(
    s.text(28, 54, 'PneumaSpace', { size: 28, weight: 600 }),
    s.text(28, 84, 'No agent inside. Built for what agents build.', { size: 16, fill: c.ink2 }),
    s.text(28, 106, 'Publish a directory. It wakes on demand, sleeps when idle and keeps its data.', { size: 12.5, fill: c.ink3 }),
  );

  const beats: Array<[number, number, string, string, string]> = [
    [0.2, 2.2, c.ink3, '', 'a directory: a manifest and src/'],
    [2.2, 4.4, c.accent, 'notes', 'publish: one bundle, no image build'],
    [4.4, 6.0, c.ink3, 'notes', 'release 1, asleep until someone visits'],
    [6.0, 7.6, c.orange, 'notes', 'first wake 460–700 ms, bundle unpacked once'],
    [7.6, 10.6, c.green, 'notes', 'awake: db, kv, object and ws mounted'],
    [10.6, 11.6, c.ink3, 'notes', 'idle, so asleep; its data stays'],
    [11.6, 14.4, c.green, 'notes', 'wakes again in 62–87 ms'],
    [14.4, 16.2, c.green, 'boxed', 'a container wakes in about 260 ms'],
    [16.2, 17.4, c.accent, 'site-docs', 'static bytes, nothing woken'],
    [17.4, 19.6, c.red, 'chat', 'a busy loop holds its worker'],
    [19.6, 21.0, c.red, 'chat', 'stopped 3.5–4 s after the stuck request'],
    [21.0, 22.2, c.red, 'chat', 'quarantined; its neighbours still answer'],
    [22.2, 24.6, c.accent, 'chat', 'release 2 replaces it'],
    [24.6, END, c.ink3, '', 'calm again: nothing awake, all data kept'],
  ];
  const px = 456, py = 62;
  s.add(s.rect(px, py, 408, 28, { r: 14, fill: c.surface, stroke: c.line }));
  beats.forEach(([on, off, fill, name, what], i) => {
    const tx = px + 26 + (name ? monoWidth(name, 11.5) + 8 : 0);
    s.add(s.layer(s.dot(px + 15, py + 14, fill) + (name ? s.text(px + 26, py + 18, name, { size: 11.5, mono: true }) : '') +
      s.text(tx, py + 18, what, { size: 12, fill: c.ink2 }), [[on, off - 0.15]], i === 4, 0.15));
  });

  s.add(s.rect(16, 124, 848, 396, { r: 14, fill: c.canvas, stroke: c.line }));
  for (const [x, label] of [[32, 'you'], [208, 'gateway'], [404, 'runtimes'], [732, 'platform services']] as const) s.add(s.text(x, 148, label, { size: 11, fill: c.ink3 }));

  const gx = 208, gw = 160;
  const rows = { ingress: 188, identity: 222, static: 256, wake: 290, guard: 324, admin: 404 };
  const rowText: Record<keyof typeof rows, [string, string]> = {
    ingress: ['ingress', ':8080'], identity: ['identity', 'login'], static: ['static', 'bundle hit'],
    wake: ['wake', 'acquire'], guard: ['Guard', 'quarantine'], admin: ['admin', ':8081'],
  };
  s.add(s.rect(gx, 168, gw, 256, { r: 14, fill: c.surface, stroke: c.line }), s.path(`M${gx + 12},364 H${gx + gw - 12}`, c.line, { dash: '3 3' }));
  for (const [k, y] of Object.entries(rows) as Array<[keyof typeof rows, number]>) {
    const [label, note] = rowText[k];
    s.add(s.dot(gx + 16, y, c.ink3, 2.5), s.text(gx + 28, y + 4, label, { size: 12 }),
      s.text(gx + gw - 12, y + 4, note, { size: 11, fill: c.ink3, anchor: 'end', mono: note.startsWith(':') }));
  }
  const light = (k: keyof typeof rows, at: number, fill = c.accent, hold = 0.45, still = false) =>
    s.add(s.layer(s.dot(gx + 16, rows[k], fill, 3.5), [[at, at + hold]], still, 0.1));

  const cardLines = ['├ pneuma-space.json', '├ src/server.ts', '├ package.json', '└ public/'];
  s.add(s.rect(32, 224, 144, 150, { r: 12, fill: c.surface, stroke: c.line }));
  s.add(s.layer(s.text(44, 248, 'notes/', { size: 12, mono: true, weight: 600 }), [[0.2, END]], true));
  cardLines.forEach((l, i) => s.add(s.layer(s.text(44, 272 + i * 20, l, { size: 10.5, mono: true, fill: c.ink2 }), [[0.45 + i * 0.25, END]], true)));
  s.add(s.layer(s.text(44, 360, 'needs', { size: 10.5, fill: c.ink3 }) + s.text(78, 360, 'db kv object ws', { size: 10.5, mono: true, fill: c.accentInk }), [[1.6, END]], true));

  s.add(s.rect(32, 392, 144, 24, { r: 12, fill: c.surface, stroke: c.line }),
    s.layer(s.rect(32, 392, 144, 24, { r: 12, stroke: c.accent }), [[2.2, 4.4], [22.2, 23.4]], false),
    s.unless(s.text(44, 408, 'appctl publish notes', { size: 10.5, mono: true, fill: c.ink2 }), [[22.2, 24.6]], true),
    s.layer(s.text(44, 408, 'appctl publish chat', { size: 10.5, mono: true, fill: c.ink2 }), [[22.2, 24.6]], false));
  const bar = s.anim([[0, 'transform:scaleX(0)'], [2.2, 'transform:scaleX(0)'], [4.2, 'transform:scaleX(1)'], [22.2, 'transform:scaleX(1)'], [22.3, 'transform:scaleX(0)'], [23.2, 'transform:scaleX(1)'], [END, 'transform:scaleX(1)'], [T, 'transform:scaleX(0)']], 'linear');
  s.css.push(`.${bar}{transform-box:fill-box;transform-origin:0 50%}`);
  s.add(s.rect(32, 424, 144, 3, { r: 1.5, fill: c.lineStrong }), s.rect(32, 424, 144, 3, { r: 1.5, fill: c.accent, cls: bar }),
    s.layer(s.text(32, 446, '6.9 s · no image build', { size: 10.5, mono: true, fill: c.ink2 }), [[4.2, 22.2]], true),
    s.layer(s.text(32, 446, 'release 2 · data kept', { size: 10.5, mono: true, fill: c.ink2 }), [[23.2, END]], false));

  s.add(caller(s, 32, rows.ingress, 144, 'visitor'));
  s.add(s.path(`M176,${rows.ingress} H${gx}`, c.lineStrong));

  const lx = 404, lw = 248, ix = 416;
  const lanes = { container: { y: 168, h: 96 }, isolate: { y: 276, h: 124 }, static: { y: 412, h: 96 } };
  lane(s, lx, 168, lw, 96, 'container', 'any image', 'Docker engine', '/data volumes');
  const isy = lane(s, lx, 276, lw, 124, 'isolate', 'a worker per app', 'runner service', '');
  lane(s, lx, 412, lw, 96, 'static', 'no process', 'bundle store', 'object storage');
  const store = (label: string, lit: boolean) => {
    const w = monoWidth(label, 10) + 10, x = lx + lw - 17 - w;
    return (lit ? s.rect(x, isy + 4, w, 16, { r: 5, fill: c.accentTint }) : '') + s.text(lx + lw - 22, isy + 16, label, { size: 10, mono: true, fill: lit ? c.accentInk : c.ink3, anchor: 'end' });
  };
  s.add(s.unless(store('files 1 · sqlite 2', false), [[8.2, END]], false), s.layer(store('files 1 · sqlite 3', true), [[8.2, END]], true));

  const wakeExit: Pt = [gx + gw, rows.wake], staticExit: Pt = [gx + gw, rows.static];
  const entry = (l: keyof typeof lanes): Pt => [lx, lanes[l].y + 22];
  s.add(s.path(curveD(...wakeExit, ...entry('container')), c.lineStrong), s.path(curveD(...wakeExit, ...entry('isolate')), c.lineStrong),
    s.path(curveD(...staticExit, ...entry('static')), c.lineStrong));

  const sx = 732, sw = 132;
  s.add(service(s, sx, 196, sw, 46, 'Redis', true, 'key prefix per app'), service(s, sx, 380, sw, 46, 'Object store', true, 'bucket per app'));
  const edges = {
    cStatic: [lx + lw, 216, sx, 391], iKv: [lx + lw, 300, sx, 219], iStatic: [lx + lw, 326, sx, 399],
    iObject: [lx + lw, 352, sx, 407], sStatic: [lx + lw, 452, sx, 415],
  } satisfies Record<string, Edge>;
  for (const k of ['cStatic', 'iKv', 'iStatic', 'sStatic'] as const) s.add(s.path(curveD(...edges[k]), c.lineStrong));
  s.add(s.layer(s.path(curveD(...edges.iObject), c.lineStrong), [[7.9, END]], true));
  s.add(s.layer(s.path(curveD(...edges.iKv), c.accent, { width: 1.5 }) + s.path(curveD(...edges.iObject), c.accent, { width: 1.5 }), [[7.9, 10.6]], true));
  const lab = (k: keyof typeof edges) => [edges[k][0] + 6, edges[k][1]] as const;
  s.add(edgeLabel(s, ...lab('cStatic'), 'static 1'), edgeLabel(s, ...lab('iStatic'), 'static 4'), edgeLabel(s, ...lab('sStatic'), 'static 1'),
    s.unless(edgeLabel(s, ...lab('iKv'), 'kv 2'), [[7.9, END]], false), s.layer(edgeLabel(s, ...lab('iKv'), 'kv 3', true), [[7.9, END]], true),
    s.layer(edgeLabel(s, ...lab('iObject'), 'object 1', true), [[7.9, END]], true));

  const chipAt = { boxed: [ix, 202], chat: [ix, 310], notes: [ix + 62, 310], survey: [ix + 131, 310], ttt: [ix, 338], widget: [ix + 62, 338], 'site-docs': [ix, 446] } as const;
  const put = (name: keyof typeof chipAt, rest: Omit<App, 'name' | 'x' | 'y'> = {}) => app(s, { name, x: chipAt[name][0], y: chipAt[name][1], ...rest });
  const boxed = put('boxed', { states: { waking: [[15.2, 15.46]], awake: [[15.46, 17.6]] } });
  const notes = put('notes', { shown: [[4.4, END]], states: { waking: [[7.0, 7.6], [12.4, 12.6]], awake: [[7.6, 10.6], [12.6, 14.2]] }, still: 'awake', w: 63 });
  const chat = put('chat', { states: { awake: [[18.3, 18.6]], bad: [[18.6, 23.4]] } });
  const survey = put('survey', { states: { awake: [[19.4, 19.9], [21.4, 21.9]] } });
  const ttt = put('ttt', { states: { awake: [[20.4, 20.9]] } });
  put('widget');
  const docs = put('site-docs', { states: { hit: [[16.9, 17.6]] } });

  const socket = { width: 1.5, dash: '4 4', cls: 'dash' };
  s.add(s.layer(s.path(`M176,${rows.ingress} H${gx}`, c.accent, socket) + s.path(curveD(...wakeExit, ...entry('isolate')), c.accent, socket) +
    s.dot(gx + 16, rows.ingress, c.accent, 3.5) + s.dot(gx + 16, rows.wake, c.accent, 3.5), [[8.0, 10.5]], true));

  const via = (stages: Array<keyof typeof rows>, exit: Pt, to: keyof typeof lanes, target: { cx: number; cy: number }): Pt[] =>
    [[176, rows.ingress], ...stages.map((k) => [gx + 16, rows[k]] as Pt), exit, ...curvePts(...exit, ...entry(to)).slice(1), [target.cx, target.cy]];
  const visit = (target: { cx: number; cy: number }, to: keyof typeof lanes, passes: Array<keyof typeof rows>, at: number, arrive: number) => {
    const stages: Array<keyof typeof rows> = to === 'static' ? ['ingress', 'identity', 'static'] : ['ingress', 'identity', 'static', 'wake'];
    const times = s.trip(via(stages, to === 'static' ? staticExit : wakeExit, to, target), at, arrive);
    stages.forEach((k, i) => passes.includes(k) && light(k, times[i + 1]));
  };
  visit(notes, 'isolate', ['ingress', 'wake'], 6.0, 7.0);
  visit(notes, 'isolate', ['ingress', 'wake'], 11.6, 12.4);
  visit(boxed, 'container', ['ingress', 'identity', 'wake'], 14.4, 15.2);
  visit(docs, 'static', ['ingress', 'static'], 16.2, 16.9);
  visit(chat, 'isolate', ['ingress', 'identity', 'wake'], 17.4, 18.3);
  visit(survey, 'isolate', ['ingress', 'identity', 'wake'], 18.6, 19.4);
  visit(ttt, 'isolate', ['ingress', 'identity', 'wake'], 19.6, 20.4);
  visit(survey, 'isolate', ['ingress', 'identity', 'wake'], 20.6, 21.4);
  light('guard', 19.6, c.red, 2.4);

  const publish = (at: number, arrive: number, target: { cx: number; cy: number }) => {
    const times = s.trip([[176, rows.admin], [gx + 16, rows.admin], [gx + gw, rows.admin], ...curvePts(gx + gw, rows.admin, lx, 384).slice(1), [target.cx, target.cy]], at, arrive);
    light('admin', times[1]);
  };
  publish(3.4, 4.4, notes);
  publish(22.4, 23.4, chat);
  s.trip(curvePts(...edges.iKv), 8.0, 8.6);
  s.trip(curvePts(...edges.iObject), 8.2, 8.8);

  return s.svg(W, H,
    'PneumaSpace. No agent inside. Built for what agents build. A directory named notes with a manifest and src is published through the admin port in seconds with no image build and lands in the isolate lane, asleep. A visitor arrives through the gateway stages; the first wake takes 460 to 700 ms, later wakes 62 to 87 ms. Its db, kv, object and ws edges light up; when idle it goes dark while its data stays. A container app wakes in about 260 ms and a static site is served with nothing woken. The chat worker hangs, turns red, is stopped 3.5 to 4 s after the stuck request and quarantined by the Guard while survey and ttt keep answering; release 2 replaces it, and the host is calm again.',
    'PneumaSpace');
}

function lanes(c: Palette) {
  const W = 880, H = 484, T = 15;
  const s = new Scene(c, T);
  s.header('01', 'Lanes', 'One gateway, three runtimes, each on its own base. An edge counts the apps that declare that capability.');
  s.add(s.rect(16, 84, 848, 384, { r: 14, fill: c.canvas, stroke: c.line }));
  for (const [x, label] of [[32, 'callers'], [168, 'gateway'], [364, 'runtimes'], [736, 'platform services']] as const) s.add(s.text(x, 108, label, { size: 11, fill: c.ink3 }));

  const gx = 168, gw = 160;
  const rows = { ingress: 148, identity: 184, static: 220, wake: 256, scheduler: 292, admin: 328 };
  const notes: Record<keyof typeof rows, string> = { ingress: ':8080', identity: 'login', static: 'bundle hit', wake: 'Guard', scheduler: 'cron', admin: ':8081' };
  s.add(s.rect(gx, 124, gw, 228, { r: 14, fill: c.surface, stroke: c.line }));
  for (const [k, y] of Object.entries(rows) as Array<[keyof typeof rows, number]>) {
    s.add(s.dot(gx + 16, y, c.ink3, 2.5), s.text(gx + 28, y + 4, k, { size: 12 }),
      s.text(gx + gw - 12, y + 4, notes[k], { size: 11, fill: c.ink3, anchor: 'end', mono: notes[k].startsWith(':') }));
  }
  s.add(caller(s, 32, rows.ingress, 104, 'visitor'), caller(s, 32, rows.admin, 104, 'operator'));
  s.add(s.path(`M136,${rows.ingress} H${gx}`, c.lineStrong), s.path(`M136,${rows.admin} H${gx}`, c.lineStrong));

  const lx = 364, lw = 288, ix = lx + 12;
  const box = { container: { y: 124, h: 92 }, isolate: { y: 228, h: 120 }, static: { y: 360, h: 92 } };
  lane(s, lx, 124, lw, 92, 'container', 'any image on :8000', 'Docker engine', '/data volumes');
  const isy = lane(s, lx, 228, lw, 120, 'isolate', 'a worker thread per app', 'runner service', 'files 1 · sqlite 2');
  lane(s, lx, 360, lw, 92, 'static', 'no process', 'bundle store', 'object storage');

  const wakeExit: Pt = [gx + gw, rows.wake], staticExit: Pt = [gx + gw, rows.static];
  const entry = (l: keyof typeof box): Pt => [lx, box[l].y + 22];
  s.add(s.path(curveD(...wakeExit, ...entry('container')), c.lineStrong), s.path(curveD(...wakeExit, ...entry('isolate')), c.lineStrong),
    s.path(curveD(...staticExit, ...entry('static')), c.lineStrong));

  const sx = 736, sw = 128;
  const svc: Array<[string, boolean, string, number]> = [
    ['Object store', true, 'buckets, bundles', 124], ['Redis', true, 'key prefix per app', 195], ['runner', true, 'isolate workers', 266],
    ['PostgreSQL', false, 'no app needs it', 337], ['coturn', false, 'no app needs it', 408],
  ];
  for (const [name, up, note, y] of svc) s.add(service(s, sx, y, sw, 44, name, up, note));
  const edges = {
    cStatic: [lx + lw, 168, sx, 138], iStatic: [lx + lw, 262, sx, 146], iKv: [lx + lw, 288, sx, 217],
    iRunner: [lx + lw, 314, sx, 288], sStatic: [lx + lw, 406, sx, 154],
  } satisfies Record<string, Edge>;
  const labels: Record<keyof typeof edges, string> = { cStatic: 'static 1', iKv: 'kv 2', iStatic: 'static 5', iRunner: '5 apps', sStatic: 'static 1' };
  for (const k of Object.keys(edges) as Array<keyof typeof edges>) s.add(s.path(curveD(...edges[k]), c.lineStrong));
  for (const k of Object.keys(edges) as Array<keyof typeof edges>) s.add(edgeLabel(s, edges[k][0] + 6, edges[k][1], labels[k]));

  const boxed = app(s, { name: 'boxed', x: ix, y: 158, states: { waking: [[1.5, 1.76]], awake: [[1.76, 4.2]] } });
  let x = ix;
  for (const name of ['chat', 'hello', 'survey']) { app(s, { name, x, y: 262 }); x += chipW(name) + 6; }
  app(s, { name: 'ttt', x: ix, y: 290 });
  const widget = app(s, { name: 'widget', x: ix + 62, y: 290, states: { waking: [[5.9, 5.98]], awake: [[5.98, 8.8]] } });
  const docs = app(s, { name: 'site-docs', x: ix, y: 394, states: { hit: [[10.2, 11.0]] } });
  s.add(pill(s, boxed.right + 8, 160, 'wake ≈ 260 ms', c.orangeTint, c.orange), pill(s, widget.right + 8, 292, 'wake 62–87 ms', c.greenTint, c.green),
    pill(s, docs.right + 8, 396, 'no wake', c.accentTint, c.accentInk));
  const litLane: Record<keyof typeof box, Win> = { container: [[0.6, 4.2]], isolate: [[5.0, 8.8]], static: [[9.4, 11.0]] };
  for (const l of Object.keys(box) as Array<keyof typeof box>) {
    s.add(s.layer(s.rect(lx, box[l].y, lw, box[l].h, { r: 14, stroke: c.accent }), litLane[l], false));
  }
  s.add(s.layer(s.rect(ix, isy, lw - 24, 24, { r: 8, stroke: c.accent }), [[6.2, 7.4]], false));
  s.add(s.layer(s.path(curveD(...edges.sStatic), c.accent, { width: 1.5 }), [[9.9, 11.0]], false));

  const visit = (target: { cx: number; cy: number }, to: keyof typeof box, passes: Array<keyof typeof rows>, at: number, arrive: number) => {
    const stages: Array<keyof typeof rows> = to === 'static' ? ['ingress', 'identity', 'static'] : ['ingress', 'identity', 'static', 'wake'];
    const exit = to === 'static' ? staticExit : wakeExit;
    const times = s.trip([[136, rows.ingress], ...stages.map((k) => [gx + 16, rows[k]] as Pt), exit, ...curvePts(...exit, ...entry(to)).slice(1), [target.cx, target.cy]], at, arrive);
    stages.forEach((k, i) => passes.includes(k) && s.add(s.layer(s.dot(gx + 16, rows[k], c.accent, 3.5), [[times[i + 1], times[i + 1] + 0.45]], false, 0.1)));
  };
  visit(boxed, 'container', ['ingress', 'identity', 'wake'], 0.6, 1.5);
  visit(widget, 'isolate', ['ingress', 'identity', 'wake'], 5.0, 5.9);
  visit(docs, 'static', ['ingress', 'static'], 9.4, 10.2);
  s.trip(curvePts(edges.sStatic[2], edges.sStatic[3], edges.sStatic[0], edges.sStatic[1]), 9.9, 10.3);

  return s.svg(W, H,
    'Lanes. Visitor and operator on the left, one gateway with ingress, identity, static, wake with the Guard, scheduler and admin stages, then three runtime lanes: container on the Docker engine and /data volumes, isolate as one worker thread per app on the runner service and its volume, static with no process on the bundle store. Edges to Redis, the object store and the runner are labelled with the number of apps that declare each capability; PostgreSQL and coturn are off because no app needs them. A request reaches each lane in turn: the container app wakes in about 260 ms, the isolate app in 62 to 87 ms, and the static site is answered from the bundle store with no wake.',
    'Lanes');
}

function graph(c: Palette) {
  const W = 880, H = 492, T = 16;
  const s = new Scene(c, T);
  s.header('02', 'Graph', 'One node per app and every edge its own: the gateway stages it passes, the capabilities it declares, the services behind them.');
  s.add(s.rect(16, 84, 848, 392, { r: 14, fill: c.canvas, stroke: c.line }));
  for (const [x, label] of [[28, 'callers'], [132, 'gateway'], [372, 'apps'], [568, 'capabilities'], [736, 'platform services']] as const) s.add(s.text(x, 108, label, { size: 11, fill: c.ink3 }));

  type Cap = 'files' | 'db:sqlite' | 'db:postgres' | 'kv' | 'object' | 'static' | 'ws' | 'cron' | 'identity' | 'rtc';
  type Svc = 'volumes' | 'runner' | 'postgres' | 'redis' | 'object' | 'coturn';
  type Stage = 'ingress' | 'identity' | 'static' | 'wake';
  const apps: Array<{ name: string; lane: 'container' | 'isolate' | 'static'; caps: Cap[] }> = [
    { name: 'boxed', lane: 'container', caps: ['identity', 'static'] },
    { name: 'chat', lane: 'isolate', caps: ['kv', 'ws', 'identity', 'static'] },
    { name: 'hello', lane: 'isolate', caps: ['identity', 'static'] },
    { name: 'survey', lane: 'isolate', caps: ['files', 'db:sqlite', 'cron', 'identity', 'static'] },
    { name: 'ttt', lane: 'isolate', caps: ['kv', 'ws', 'identity', 'static'] },
    { name: 'widget', lane: 'isolate', caps: ['db:sqlite', 'cron', 'identity', 'static'] },
    { name: 'site-docs', lane: 'static', caps: ['static'] },
  ];
  const caps: Cap[] = ['files', 'db:sqlite', 'db:postgres', 'kv', 'object', 'static', 'ws', 'cron', 'identity', 'rtc'];
  const services: Array<[Svc, string, boolean, string]> = [
    ['volumes', 'volumes', true, 'Docker, for /data'], ['runner', 'runner', true, 'its volume, workers'], ['postgres', 'PostgreSQL', false, 'no app needs it'],
    ['redis', 'Redis', true, 'key prefix per app'], ['object', 'Object store', true, 'buckets, bundles'], ['coturn', 'coturn', false, 'no app needs it'],
  ];
  const serviceOf = (cap: Cap, lane: string): Svc | null =>
    cap === 'files' || cap === 'db:sqlite' ? (lane === 'isolate' ? 'runner' : 'volumes')
      : ({ 'db:postgres': 'postgres', kv: 'redis', object: 'object', static: 'object', rtc: 'coturn' } as Partial<Record<Cap, Svc>>)[cap] ?? null;
  const passes = (a: (typeof apps)[number]): Stage[] =>
    ['ingress', a.caps.includes('identity') && 'identity', a.caps.includes('static') && 'static', a.lane !== 'static' && 'wake'].filter(Boolean) as Stage[];

  const gx = 132, gw = 216, bandW = (gw - 16) / 4, top = 124, bottom = 412;
  const stages: Stage[] = ['ingress', 'identity', 'static', 'wake'];
  const bandX = (i: number) => gx + 8 + i * bandW + bandW / 2;
  s.add(s.rect(gx, top, gw, bottom - top, { r: 14, fill: c.surface, stroke: c.line }));
  stages.forEach((st, i) => s.add(s.rect(gx + 8 + i * bandW + 3, top + 8, bandW - 6, bottom - top - 16, { r: 9, fill: i === 0 ? c.accentTint : c.inset, stroke: c.line }),
    s.text(bandX(i), top + 26, st, { size: 10.5, fill: c.ink2, anchor: 'middle' })));
  const scheduler = (lit: boolean) => s.rect(gx, 422, gw, 40, { r: 10, fill: c.surface, stroke: lit ? c.accent : c.line }) +
    s.text(gx + 12, 439, 'scheduler', { size: 11.5, weight: 600 }) + s.text(gx + 12, 454, 'cron deliveries', { size: 10.5, fill: c.ink3, mono: true });
  s.add(scheduler(false));

  const vy = 196;
  s.add(caller(s, 28, vy, 92, 'visitor'));
  const fx = bandX(0) - 10;
  s.add(s.path(curveD(120, vy, fx, vy), c.lineStrong));

  const ax = 372, aw = 140;
  const rowY: Record<string, number> = {};
  const groupY: Record<string, number> = {};
  let y = top;
  for (const l of ['container', 'isolate', 'static'] as const) {
    const members = apps.filter((a) => a.lane === l);
    groupY[l] = y;
    s.add(s.text(ax, y + 16, `${l}  ${members.length}`, { size: 11.5, mono: true, fill: c.ink2 }));
    y += 24;
    for (const a of members) { rowY[a.name] = y + 11; y += 26; }
    y += 8;
  }
  const cx = 568, cw = 124;
  const capY = Object.fromEntries(caps.map((k, i) => [k, top + 12 + (i * (bottom - top - 18)) / (caps.length - 1)])) as Record<Cap, number>;
  const sx = 736, sw = 128, sh = 40;
  const svcY = Object.fromEntries(services.map(([k], i) => [k, top + (i * (bottom + 50 - top - sh)) / (services.length - 1)])) as Record<Svc, number>;

  const lanePath = (ry: number) => `M${fx},${vy} C${fx + 14},${vy} ${fx - 4},${ry} ${fx + 14},${ry} H${ax}`;
  const cronPath = (ry: number) => `M${bandX(3) + 8},422 V${ry + 6} Q${bandX(3) + 8},${ry} ${bandX(3) + 14},${ry}`;
  const runnerPath = `M${ax + aw},${groupY.isolate + 12} C${ax + aw + 24},${groupY.isolate + 12} ${ax + aw + 8},${top - 6} ${ax + aw + 36},${top - 6} H${cx + cw + 4} C${sx - 24},${top - 6} ${sx - 30},${svcY.runner + 20} ${sx},${svcY.runner + 20}`;
  const draw = (lit: boolean, only?: string) => {
    const stroke = lit ? c.accent : c.lineStrong, width = lit ? 1.5 : undefined;
    const out: string[] = [];
    for (const a of apps) {
      if (only && a.name !== only) continue;
      const ry = rowY[a.name];
      out.push(s.path(lanePath(ry), stroke, { width }));
      for (const p of passes(a)) out.push(`<circle cx="${bandX(stages.indexOf(p))}" cy="${ry}" r="3.5" fill="${c.surface}" stroke="${lit ? c.accent : c.ink3}"/>`);
      if (a.caps.includes('cron')) out.push(s.path(cronPath(ry), lit ? c.accent : c.lineStrong, { dash: '2 3', width }));
      for (const k of a.caps) out.push(s.path(curveD(ax + aw, ry, cx, capY[k]), stroke, { width }));
    }
    for (const k of caps) {
      const users = apps.filter((a) => a.caps.includes(k) && (!only || a.name === only));
      for (const sv of new Set(users.map((a) => serviceOf(k, a.lane)).filter(Boolean) as Svc[])) out.push(s.path(curveD(cx + cw, capY[k], sx, svcY[sv] + 20), stroke, { width }));
    }
    if (!only || apps.find((a) => a.name === only)?.lane === 'isolate') out.push(s.path(runnerPath, lit ? c.accent : c.lineStrong, { dash: '2 3', width }));
    return out.join('');
  };
  s.add(draw(false));

  const capNode = (k: Cap, lit: boolean) => {
    const n = apps.filter((a) => a.caps.includes(k)).length;
    const [kind, engine] = k.split(':');
    const label = engine ? `db · ${engine === 'sqlite' ? 'SQLite' : 'PostgreSQL'}` : kind;
    return s.rect(cx + 0.5, capY[k] - 11.5, cw - 1, 23, { r: 6, fill: lit ? c.surface : c.inset, stroke: lit ? c.accent : c.line }) +
      s.text(cx + 9, capY[k] + 4, label, { size: 10.5, mono: true, fill: n || lit ? c.ink : c.ink3 }) +
      s.text(cx + cw - 9, capY[k] + 4, n ? String(n) : '·', { size: 10.5, mono: true, fill: c.ink3, anchor: 'end' });
  };
  for (const k of caps) s.add(capNode(k, false));
  for (const [k, name, up, note] of services) s.add(service(s, sx, svcY[k], sw, sh, name, up, note));
  for (const l of ['container', 'isolate', 'static'] as const) for (const a of apps.filter((x) => x.lane === l)) app(s, { name: a.name, x: ax, y: rowY[a.name] - 11, w: aw });

  const litService = (k: Svc) => { const [, name, up, note] = services.find(([x]) => x === k)!; return service(s, sx, svcY[k], sw, sh, name, up, note, true); };
  const select = (name: string, on: number, off: number, still: boolean) => {
    const a = apps.find((x) => x.name === name)!;
    const ry = rowY[name];
    s.add(s.layer(s.rect(17, 116, 846, 359, { r: 13, fill: c.canvas, opacity: 0.66 }), [[on, off]], still, 0.3));
    s.add(s.layer(caller(s, 28, vy, 92, 'visitor', true), [[on, off]], still));
    const times = s.trip([[120, vy], ...curvePts(120, vy, fx, vy, 4).slice(1), [fx + 7, (vy + ry) / 2], [fx + 14, ry], ...stages.map((_, i) => [bandX(i), ry] as Pt), [ax, ry]], on + 0.2, on + 1.2);
    s.add(s.layer(s.path(lanePath(ry), c.accent, { width: 1.5 }), [[on + 0.2, off]], still));
    passes(a).forEach((p) => s.add(s.layer(`<circle cx="${bandX(stages.indexOf(p))}" cy="${ry}" r="3.5" fill="${c.accent}"/>`, [[times[7 + stages.indexOf(p)], off]], still, 0.1)));
    s.add(s.layer(chip(s, ax, ry - 11, name, 'lit', aw), [[on + 1.2, on + 1.3]], false, 0.1),
      s.layer(chip(s, ax, ry - 11, name, 'waking', aw), [[on + 1.25, on + 1.4]], false, 0.1),
      s.layer(chip(s, ax, ry - 11, name, 'awake', aw), [[on + 1.4, off]], still, 0.1));
    for (const k of a.caps) {
      s.add(s.layer(s.path(curveD(ax + aw, ry, cx, capY[k]), c.accent, { width: 1.5 }), [[on + 1.5, off]], still));
      s.trip(curvePts(ax + aw, ry, cx, capY[k]), on + 1.5, on + 2.1);
      s.add(s.layer(capNode(k, true), [[on + 2.1, off]], still, 0.15));
      const sv = serviceOf(k, a.lane);
      if (!sv) continue;
      s.add(s.layer(s.path(curveD(cx + cw, capY[k], sx, svcY[sv] + 20), c.accent, { width: 1.5 }), [[on + 2.2, off]], still));
      s.trip(curvePts(cx + cw, capY[k], sx, svcY[sv] + 20), on + 2.2, on + 2.8);
      s.add(s.layer(litService(sv), [[on + 2.8, off]], still, 0.15));
    }
    if (a.lane === 'isolate') {
      s.add(s.layer(s.path(runnerPath, c.accent, { dash: '2 3', width: 1.5 }), [[on + 1.5, off]], still),
        s.layer(litService('runner'), [[on + 2.8, off]], still, 0.15));
    }
    if (a.caps.includes('cron')) {
      s.add(s.layer(s.path(cronPath(ry), c.accent, { dash: '2 3', width: 1.5 }) + scheduler(true), [[on + 3.4, off]], still));
      s.trip([[bandX(3) + 8, 422], [bandX(3) + 8, ry + 6], [bandX(3) + 14, ry]], on + 3.4, on + 4.0);
    }
  };
  select('survey', 0.4, 7.4, true);
  select('ttt', 8.4, 15.4, false);

  return s.svg(W, H,
    'Graph. Five columns: the visitor, the gateway with its ingress, identity, static and wake stages and the scheduler below, seven apps grouped by runtime, ten capability nodes with the number of apps that declare each, and six platform services. The survey app is selected: the rest dims, a request travels from the visitor through ingress, identity, static and wake to survey, then its edges light to files, db on SQLite, cron, identity and static, and from there to the runner and the object store, with the scheduler delivering its cron trigger. Then ttt is selected the same way, its edges reaching kv, ws, identity and static, Redis and the object store.',
    'Graph');
}

const scenes = { hero, lanes, graph };
const dir = new URL('.', import.meta.url);
for (const [name, render] of Object.entries(scenes)) {
  for (const theme of Object.keys(TOKENS) as Theme[]) {
    const palette = Object.fromEntries(Object.entries(TOKENS[theme]).map(([k, v]) => [k, hex(v)])) as Palette;
    writeFileSync(new URL(`${name}-${theme}.svg`, dir), render(palette));
  }
}
