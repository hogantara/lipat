# Empty-state doodles

Drawn in code with [anidoodle](https://github.com/alexgreensh/anidoodle) (Apache-2.0), ink and line-wash hand.

Each picture ships as three alpha masks, drawn in black on a transparent sheet. `css/app.css` paints them in the
theme's own colours, so one set of files serves paper, sepia, mist and night:

- `*-ink.webp`: the line, painted in `--ink`
- `*-accent.webp`: the one green part, painted in `--accent`
- `*-tone.webp`: soft shadows, painted in `--ink` at low opacity (black in night), half size

To redraw:

1. Scaffold an anidoodle project (`node <skill>/engine/tools/scaffold.mjs art --still shelfBook`).
2. Copy `shelfBook.ts` and `marksSheet.ts` into its `src/canvas-core/`.
3. Add one re-export module and host page per layer (`shelfBookInk`, `shelfBookAccent`, `shelfBookTone`, same for `marksSheet`).
4. Render each with `node tools/still.mjs <name> --out out/<name>.png`. Render the plain `shelfBook` and `marksSheet` names for a preview on the paper theme.
5. Convert each layer to WebP, alpha only, RGB black. Downscale the tone layers by half.
