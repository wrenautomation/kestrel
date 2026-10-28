/** Box sizes from the real text: the label and one-liner wrap, never clip (fonts as in style.css). */
import type { Pad, Size } from "@wrenautomation/orrery";
import type { TreeNode } from "../../src/view/types";

const BODY = '"Figtree", system-ui, -apple-system, sans-serif';
const LABEL = { font: `650 13.5px ${BODY}`, lh: 17 };
const LINE = { font: `400 12px ${BODY}`, lh: 15 };
const SUB_H = 16;
const PAD = { x: 28, y: 14 };
const W = { min: 150, max: 260 };

let ctx: CanvasRenderingContext2D | null | undefined;
const width = (text: string, font: string) => {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return text.length * 7;
  ctx.font = font;
  return ctx.measureText(text).width;
};

/** Rows `text` takes at `max` px, breaking at spaces (a label also after - . / _). */
function rows(text: string, font: string, max: number, label: boolean): number {
  const words = text.split(label ? /(?<=[-./_ ])/ : / /);
  let n = 1;
  let at = 0;
  for (const w of words) {
    const ww = width(label ? w : `${w} `, font);
    if (at && at + ww > max) {
      n++;
      at = ww;
    } else at += ww;
  }
  return n;
}

/** Fan-in widens a box, up to half again. */
export const scaleOf = (fanIn: number) => 1 + Math.min(0.5, Math.log2(1 + fanIn) / 10);

/** `top`: room a shape keeps over the text (a drum's lid). */
export function boxSize(n: TreeNode, fanIn: number, top = 0): Size {
  const s = scaleOf(fanIn);
  const want = Math.max(width(n.label, LABEL.font), n.line ? width(n.line, LINE.font) * 0.6 : 0);
  const w = Math.round(Math.min(W.max, Math.max(W.min, want + PAD.x)) * s);
  const inner = w - PAD.x;
  const h =
    top +
    PAD.y +
    rows(n.label, LABEL.font, inner, true) * LABEL.lh +
    SUB_H +
    (n.line ? rows(n.line, LINE.font, inner, false) * LINE.lh + 3 : 0);
  return { w, h: Math.round(Math.max(52 * s, h)) };
}

/** An open container: its title and one-liner on top, its kids under. */
export const ZONE: Pad = { top: 62, side: 18, bottom: 18 };

/** The largest label font (px) that fits its box in up to 3 rows: zoomed-out labels grow to it, no further. */
export function labelFit(n: TreeNode, w: number, h: number, top = 0): number {
  const at = width(n.label, LABEL.font);
  const iw = (w - PAD.x) * 0.92;
  const ih = h - PAD.y - top;
  let best = 0;
  for (let r = 1; r <= 3; r++)
    best = Math.max(best, Math.min((13.5 * r * iw) / at, ih / (r * 1.25)));
  return Math.round(Math.max(13.5, best) * 10) / 10;
}
