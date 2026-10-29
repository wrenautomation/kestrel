/** Box sizes from the real text: the label and one-liner wrap, never clip (fonts as in style.css). */
import type { Pad, Size } from "@wrenautomation/orrery";
import type { TreeNode } from "../../src/view/types";

const BODY = '"Figtree", system-ui, -apple-system, sans-serif';
const LABEL = { font: `650 13.5px ${BODY}`, lh: 17 };
const LINE = { font: `400 12px ${BODY}`, lh: 15 };
/** The role kicker over the label, and the stat footer under it. */
const KICK_H = 17;
const SUB_H = 19;
const PAD = { x: 30, y: 22 };
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

/** Room every box keeps right and below for a closed container's stacked sheets. */
export const STACK = 5;

/** `top`: room a shape keeps over the text (a drum's lid). */
export function boxSize(n: TreeNode, fanIn: number, top = 0): Size {
  const s = scaleOf(fanIn);
  const want = Math.max(width(n.label, LABEL.font), n.line ? width(n.line, LINE.font) * 0.6 : 0);
  const w = Math.round(Math.min(W.max, Math.max(W.min, want + PAD.x)) * s);
  const inner = w - PAD.x;
  const h =
    top +
    PAD.y +
    KICK_H +
    rows(n.label, LABEL.font, inner, true) * LABEL.lh +
    SUB_H +
    (n.line ? rows(n.line, LINE.font, inner, false) * LINE.lh + 3 : 0);
  return { w: w + STACK, h: Math.round(Math.max(64 * s, h)) + STACK };
}

/** An open container: its title and one-liner on top, its kids under. */
export const ZONE: Pad = { top: 76, side: 22, bottom: 22 };

/** The largest label font (px) that fits its box in up to 3 rows: zoomed-out labels grow to it, no further. */
export function labelFit(n: TreeNode, w: number, h: number, top = 0): number {
  const at = width(n.label, LABEL.font);
  const iw = (w - STACK - PAD.x) * 0.92;
  const ih = h - STACK - PAD.y - top;
  let best = 0;
  for (let r = 1; r <= 3; r++)
    best = Math.max(best, Math.min((13.5 * r * iw) / at, ih / (r * 1.25)));
  return Math.round(Math.max(13.5, best) * 10) / 10;
}
