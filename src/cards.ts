/**
 * The ICM cards' side of the map: the why, trade-offs and extension points. Kestrel reads only
 * their frontmatter: `entity` (a path that must exist), `covers` (generated node ids), and
 * `stamp` (the hash of those nodes when someone last read the card against them).
 */
import type { Graph } from "./model.js";
import { todo } from "./todo.js";

export interface Card {
  path: string;
  entity?: string;
  covers: string[];
  stamp?: string;
}

export type CardIssue =
  | { rule: "coverage"; node: string }
  | { rule: "entity"; card: string; entity: string }
  | { rule: "stale"; card: string; covers: string[] };

export async function readCards(root: string, dir: string): Promise<Card[]> {
  return todo(root, dir);
}

/** Hash of the approved nodes and edges a card covers. */
export function stampOf(card: Card, approved: readonly Graph[]): string {
  return todo(card, approved);
}

/**
 * coverage: a node of a required kind that no card covers.
 * entity: a card whose entity path is gone.
 * stale: a card whose stamp no longer matches its covered nodes.
 */
export function checkCards(
  root: string,
  cards: readonly Card[],
  approved: readonly Graph[],
  require: readonly string[],
): Promise<CardIssue[]> {
  return todo(root, cards, approved, require);
}

/** Writes the current stamp into a card's frontmatter, after a person read it. */
export async function restamp(root: string, card: Card, approved: readonly Graph[]): Promise<void> {
  return todo(root, card, approved);
}
