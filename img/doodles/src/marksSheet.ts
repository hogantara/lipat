import { Gfx, rng, type Ctx, type Env, type Medium, type P } from "./core";
import type { Film } from "./film";
import { lerpP, smooth } from "./gallery";
import type { Layer } from "./shelfBook";

// LIPAT · EMPTY MARKS. "Nothing kept yet." A single loose page, turned a few degrees, with the shelf's
// ribbon tucked under its top edge, and the first keep happening: a green marker half way through one
// phrase, a small asterisk pencilled in the margin beside it. Sibling of shelfBook: the same nib, the
// same ribbon, the same one accent, delivered as the same three masks.

const W = 720, H = 540;
const NIB: Medium = { nib: 1.7, taper: 1, pressure: 1.75, retrace: false, wobble: 1.2, rough: 0.6 };
const PAGE = "#f6f6f4", INK = "#171717", ACCENT = "#1f6b47";

// the sheet, by its corners, then turned about its centre
const ANG = (-4 * Math.PI) / 180, CX = 360, CY = 270;
const rot = ([x, y]: P): P => { const dx = x - CX, dy = y - CY; return [CX + dx * Math.cos(ANG) - dy * Math.sin(ANG), CY + dx * Math.sin(ANG) + dy * Math.cos(ANG)]; };
const SHEET: P[] = [[196, 62], [528, 58], [536, 470], [190, 476]];
const S = SHEET.map(rot);
const edge = (a: P, b: P, bow: number, n = 18): P[] => { const m = lerpP(a, b, 0.5), dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy); const c: P = [m[0] - (dy / l) * bow, m[1] + (dx / l) * bow]; return Array.from({ length: n + 1 }, (_, i) => { const t = i / n, u = 1 - t; return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]] as P; }); };
// text lines in sheet space, turned with the sheet; the kept phrase is on line 4
const LINE = (i: number): [P, P] => { const y = 132 + i * 34, x0 = 234, x1 = i === 2 || i === 7 ? 400 : 492 - (i % 3) * 8; return [rot([x0, y]), rot([x1, y])]; };
const KEEP: [P, P] = [rot([262, 236]), rot([420, 236])];

export const drawMarksSheet = (layer: Layer) => (ctx: Ctx, _frame: number, env: Env) => {
  const g = new Gfx(ctx, env, 0, NIB);
  ctx.setTransform(env.scale, 0, 0, env.scale, 0, 0);
  const show = (l: Layer) => layer === "preview" || layer === l;
  const col = (c: string) => (layer === "preview" ? c : "#000000");
  if (layer === "preview") { ctx.fillStyle = PAGE; ctx.fillRect(0, 0, W, H); }
  const pen = (pts: P[], w: number, seed: number, op = 0.95, wob = 0.9) => g.pen(pts, { w, color: col(INK), seed, wobble: wob, boil: 0, taper: 1, opacity: op, retrace: false });

  // TONE: the sheet lifts off the table a little, so its shadow sits low and to the right
  if (show("tone")) g.group("paint", () => {
    const k = layer === "preview" ? 0.35 : 1;
    // a thin strip along the bottom and right edges, widest at the far corner
    const strip: P[] = [lerpP(S[1], S[2], 0.16), S[2], lerpP(S[2], S[3], 0.94), [lerpP(S[2], S[3], 0.94)[0] + 4, lerpP(S[2], S[3], 0.94)[1] + 9], [S[2][0] + 11, S[2][1] + 12], [lerpP(S[1], S[2], 0.16)[0] + 9, lerpP(S[1], S[2], 0.16)[1] + 4]];
    g.wash(strip, col(INK), { alpha: 0.32 * k, seed: 3, dx: 0, dy: 0, shrink: 1, rim: false });
  });

  // ACCENT: the ribbon under the top edge, and the marker sweep, wide and a little uneven, stopping short
  // the ribbon comes out from under the bottom edge, as it does from the foot of the shelf's book
  const RL = smooth([rot([420, 466]), rot([416, 490]), rot([422, 512])], false, 6), RR = smooth([rot([438, 466]), rot([434, 490]), rot([440, 510])], false, 6);
  const RIBBON: P[] = [...RL, rot([430, 500]), ...RR.slice().reverse()];
  const sweep = (a: P, b: P, t: number): P[] => { const e = lerpP(a, b, t), r = rng(7); const top = smooth([[a[0] - 4, a[1] - 13], lerpP([a[0], a[1] - 15], [e[0], e[1] - 12], 0.5), [e[0] + 2, e[1] - 11]], false, 6); const bot = smooth([[e[0] - 2, e[1] + 9], lerpP([a[0], a[1] + 10], [e[0], e[1] + 8], 0.5), [a[0] - 6, a[1] + 8]], false, 6); return [...top.map(([x, y]) => [x, y + (r() - 0.5) * 2] as P), ...bot]; };
  if (show("accent")) {
    g.group("paint", () => g.wash(sweep(KEEP[0], KEEP[1], 0.72), col(ACCENT), { alpha: 0.5, seed: 21, dx: 0, dy: 0, shrink: 1, rim: true }));
    g.group("plain", () => g.fill(RIBBON, col(ACCENT), 0.92));
  }

  // INK
  if (show("ink")) g.group("ink", () => {
    // the sheet: bottom and right pressed, the lit top and left edges lighter and broken
    pen(edge(S[0], S[1], 2).slice(0, 13), 2, 30, 0.8); pen(edge(S[0], S[1], 2).slice(15), 2, 31, 0.8);
    pen(edge(S[1], S[2], -3), 3, 32); pen(edge(S[2], S[3], 3), 3.4, 33); pen(edge(S[3], S[0], 2), 2.2, 34, 0.85);
    // the text, loose; the kept line pressed a touch harder
    for (let i = 0; i < 9; i++) { const [a, b] = LINE(i), m = lerpP(a, b, 0.5); pen([a, [m[0], m[1] - 3], b], i === 3 ? 1.2 : 1.05, 40 + i, i === 3 ? 0.55 : 0.42, 0.5); }
    // the marker's own edge where it stopped, and the asterisk in the margin
    const e = lerpP(KEEP[0], KEEP[1], 0.72);
    pen([[e[0] + 1, e[1] - 11], [e[0] + 3, e[1]], [e[0] - 1, e[1] + 9]], 1.2, 50, 0.5, 0.3);
    const st = rot([212, 236]);
    [0, 1, 2].forEach((k) => { const a = (k * Math.PI) / 3 + 0.2, dx = Math.cos(a) * 9, dy = Math.sin(a) * 9; pen([[st[0] - dx, st[1] - dy], [st[0] + dx, st[1] + dy]], 1.4, 60 + k, 0.7, 0.2); });
    // the ribbon's edges, and the line where it goes under the sheet
    pen(RL, 1.4, 70, 0.7, 0.3); pen(RR, 1.4, 71, 0.7, 0.3);
  });
};

const film = (layer: Layer): Film => ({
  meta: { title: `Lipat empty marks · ${layer}`, W, H, fps: 30, bpm: 60, durationFrames: 1 },
  assets: { images: {} },
  shots: [{ id: "marksSheet", start: 0, end: 1, draw: drawMarksSheet(layer) }],
});
export const marksSheet = film("preview");
export const marksSheetInk = film("ink");
export const marksSheetAccent = film("accent");
export const marksSheetTone = film("tone");
