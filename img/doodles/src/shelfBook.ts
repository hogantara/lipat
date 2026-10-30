import { Gfx, rng, type Ctx, type Env, type Medium, type P } from "./core";
import type { Film } from "./film";
import { blob, lerpP, smooth } from "./gallery";

// LIPAT · EMPTY SHELF. "Nothing folded yet." An open book lying flat, seen a little from above, and the
// top corner of its right page just starting to curl over: the moment before the first fold. One idea,
// one focal part (the curl), one light from the upper left.
//
// Drawn for a page with four themes. The picture is delivered as alpha masks, one per colour role, and
// the page paints each mask in its own theme colour: INK (the line), ACCENT (the back of the curling
// corner and the ribbon) and TONE (the soft shade in the gutter and under the book). Mask layers are
// drawn in black on a transparent sheet; PREVIEW composites them on the paper theme for review.

export type Layer = "ink" | "accent" | "tone" | "preview";
const W = 960, H = 520, TOP = 190;   // drawn on a 960x720 sheet, cropped to the book
const NIB: Medium = { nib: 1.7, taper: 1, pressure: 1.75, retrace: false, wobble: 1.2, rough: 0.6 };
const PAGE = "#f6f6f4", INK = "#171717", ACCENT = "#1f6b47";

// a quadratic through a control point, sampled
const quad = (a: P, c: P, b: P, n = 24): P[] => Array.from({ length: n + 1 }, (_, i) => { const t = i / n, u = 1 - t; return [u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]] as P; });
const at = (pts: P[], t: number): P => { const n = (pts.length - 1) * t, i = Math.min(pts.length - 2, Math.floor(n)); return lerpP(pts[i], pts[i + 1], n - i); };

// ---------------------------------------------------------------- the book, by hand-placed points
const SPINE_T: P = [480, 252], SPINE_B: P = [480, 596];
const L_TOP = quad([118, 226], [300, 188], SPINE_T), L_BOT = quad([136, 566], [310, 528], SPINE_B), L_OUT = quad([118, 226], [110, 400], [136, 566]);
const R_TOP = quad(SPINE_T, [660, 188], [842, 226]), R_BOT = quad(SPINE_B, [650, 528], [824, 566]), R_OUT = quad([842, 226], [850, 400], [824, 566]);

// the curl: the corner C leaves the top edge at A and the outer edge at B. Folded flat it would land on C
// reflected across AB; curling, it stops a little short of that, its two edges bowed toward us.
const C: P = [842, 226], CA = at(R_TOP, 0.62), CB = at(R_OUT, 0.34);
const reflect = (p: P, a: P, b: P): P => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy), ux = dx / l, uy = dy / l, k = (p[0] - a[0]) * ux + (p[1] - a[1]) * uy, f: P = [a[0] + k * ux, a[1] + k * uy]; return [2 * f[0] - p[0], 2 * f[1] - p[1]]; };
const FLAT = reflect(C, CA, CB), TIP = lerpP(FLAT, lerpP(CA, CB, 0.5), 0.26);
const E1 = quad(CA, [CA[0] - 14, (CA[1] + TIP[1]) / 2 + 6], TIP, 16), E2 = quad(TIP, [(TIP[0] + CB[0]) / 2 + 10, (TIP[1] + CB[1]) / 2 + 14], CB, 16);
const ROLL = quad(CB, lerpP(lerpP(CA, CB, 0.5), C, 0.28), CA, 16);                       // the soft roll where it bends
const CURL_BACK: P[] = [...E1, ...E2.slice(1), ...ROLL.slice(1)];
const inside = (pt: P, poly: P[]) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c; } return c; };
const LIFTED: P[] = [CA, C, CB, ...E2.slice().reverse(), ...E1.slice().reverse()];          // the flap and the corner it left

export const drawShelfBook = (layer: Layer) => (ctx: Ctx, _frame: number, env: Env) => {
  const g = new Gfx(ctx, env, 0, NIB);
  ctx.setTransform(env.scale, 0, 0, env.scale, 0, 0);
  const show = (l: Layer) => layer === "preview" || layer === l;
  const col = (c: string) => (layer === "preview" ? c : "#000000");
  if (layer === "preview") { ctx.fillStyle = PAGE; ctx.fillRect(0, 0, W, H); }
  g.push(0, -TOP, 1);
  const pen = (pts: P[], w: number, seed: number, op = 0.95, wob = 0.9) => g.pen(pts, { w, color: col(INK), seed, wobble: wob, boil: 0, taper: 1, opacity: op, retrace: false });

  // TONE: the book's shadow on the table, then the shade that gathers in the gutter of both pages
  if (show("tone")) g.group("paint", () => {
    const k = layer === "preview" ? 0.35 : 1;
    g.wash(blob(486, 628, 372, 26, 3, 0.12, 22), col(INK), { alpha: 0.32 * k, seed: 3, dx: 0, dy: 0, shrink: 1, rim: false });
    // the gutter: two thin wedges that thicken toward the foot of the spine, lighter on the lit left page
    g.wash([[478, 262], [470, 300], [458, 420], [452, 560], [478, 590]], col(INK), { alpha: 0.14 * k, seed: 4, dx: 0, dy: 0, shrink: 1, rim: false });
    g.wash([[482, 262], [494, 300], [510, 420], [516, 560], [482, 590]], col(INK), { alpha: 0.2 * k, seed: 6, dx: 0, dy: 0, shrink: 1, rim: false });
    // the flap casts a thin shadow on the page under its two lifted edges
    g.wash([...E1, ...E2.slice(1), ...E2.slice().reverse().map(([x, y]) => [x - 6, y + 10] as P), ...E1.slice().reverse().map(([x, y]) => [x - 9, y + 8] as P)], col(INK), { alpha: 0.3 * k, seed: 5, dx: 0, dy: 0, shrink: 1, rim: false });
  });

  // ACCENT: the back of the curling corner, and a ribbon marker hanging from the foot of the spine
  // the ribbon: two edges that keep their width through one easy S, cut in a swallowtail
  const RL = smooth([[471, 598], [466, 632], [474, 664], [468, 698]], false, 6), RR = smooth([[489, 598], [484, 632], [492, 664], [488, 696]], false, 6);
  const RIBBON: P[] = [...RL, [478, 684], ...RR.slice().reverse()];
  if (show("accent")) g.group("paint", () => {
    g.wash(CURL_BACK, col(ACCENT), { alpha: 0.42, seed: 21, dx: 0, dy: 0, shrink: 1, rim: true });
    g.wash(ROLL.concat([lerpP(CA, CB, 0.5)]), col(ACCENT), { alpha: 0.35, seed: 23, dx: 0, dy: 0, shrink: 1, rim: false });   // darker where it rolls away from the light
    g.fill(RIBBON, col(ACCENT), 0.92);
  });

  // INK: the flexible nib. Firm along the bottoms and the curl, lifted along the lit top edges.
  if (show("ink")) g.group("ink", () => {
    // pages: top edges light and open near the spine, the outer edges and bottoms pressed
    pen(L_TOP.slice(0, 20), 2.2, 30, 0.85); pen([...R_TOP.slice(4).filter((p) => p[0] < CA[0] - 2), CA], 2.2, 31, 0.85);
    pen(L_OUT, 3.1, 33); pen(R_OUT.filter((p) => p[1] > CB[1] - 1), 3.1, 34);
    pen(L_BOT, 3.6, 35); pen(R_BOT, 3.6, 36);
    // the spine fold, a single searching line that fades out toward the top
    pen([SPINE_T, [482, 400], SPINE_B], 1.6, 37, 0.7, 0.5);
    // the page block under each page and the cover board under both, offset down and out
    [[8, 0.6], [15, 0.45]].forEach(([d, op], i) => {
      pen(quad([138 - d * 0.4, 566 + d], [310, 530 + d], [SPINE_B[0], SPINE_B[1] + d]), 1.5, 40 + i, op);
      pen(quad([SPINE_B[0], SPINE_B[1] + d], [650, 530 + d], [826 + d * 0.4, 566 + d]), 1.5, 42 + i, op);
    });
    pen(quad([104, 238], [100, 420], [126, 592]), 2.4, 46, 0.9); pen(quad([126, 592], [306, 556], [480, 624]), 3.4, 47);
    pen(quad([856, 238], [862, 420], [834, 592]), 2.4, 48, 0.9); pen(quad([480, 624], [654, 556], [834, 592]), 3.4, 49);
    pen([[104, 238], [118, 226]], 1.6, 50, 0.8); pen([[856, 238], [842, 226]], 1.6, 51, 0.8);
    // the curl: its two edges pressed hardest of anything, the roll left as a light searching line
    pen(E1, 2.6, 60, 0.95, 0.5); pen(E2, 3.4, 63, 0.97, 0.5);
    pen(ROLL, 2, 61, 0.8, 0.4);
    // two quick arcs off the tip, the way a doodle says "moving"
    const off = (d: number): P[] => quad([TIP[0] - 18 - d, TIP[1] + 10 + d * 0.4], [TIP[0] - 38 - d, TIP[1] - 18 - d * 0.2], [TIP[0] - 30 - d * 0.6, TIP[1] - 56 - d * 0.2], 10);
    pen(off(0), 1.3, 64, 0.6, 0.3); pen(off(14).slice(2, 9), 1.1, 65, 0.4, 0.3);
    // the text: loose lines that follow each page's bow, shorter on the last line of a paragraph
    const r = rng(70);
    const lines = (top: P[], bot: P[], from: number, to: number, side: number, seed: number, stop?: (p: P) => boolean) => {
      for (let i = 0; i < 9; i++) {
        const t = 0.14 + i * 0.085, short = i === 3 || i === 8, a = lerpP(at(top, from), at(bot, from), t), b = lerpP(at(top, to), at(bot, to), t);
        const end = lerpP(a, b, short ? 0.55 + r() * 0.15 : 0.92 + r() * 0.08), mid = lerpP(a, end, 0.5);
        let seg: P[] = [a, [mid[0], mid[1] - 5 * side], end];
        if (stop) seg = smooth(seg, false, 8).filter((p) => !stop(p));
        if (seg.length > 1) pen(seg, 1.05, seed + i, 0.42, 0.5);
      }
    };
    lines(L_TOP, L_BOT, 0.1, 0.86, 1, 80);
    lines(R_TOP, R_BOT, 0.14, 0.9, 1, 100, (p) => inside(p, LIFTED) || inside([p[0] + 14, p[1] - 10], LIFTED));
  });
};

const film = (layer: Layer): Film => ({
  meta: { title: `Lipat empty shelf · ${layer}`, W, H, fps: 30, bpm: 60, durationFrames: 1 },
  assets: { images: {} },
  shots: [{ id: "shelfBook", start: 0, end: 1, draw: drawShelfBook(layer) }],
});
export const shelfBook = film("preview");
export const shelfBookInk = film("ink");
export const shelfBookAccent = film("accent");
export const shelfBookTone = film("tone");
