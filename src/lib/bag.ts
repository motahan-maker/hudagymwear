import type { Product } from './catalog';

/**
 * A bag line is a product in a size AND a colour.
 *
 * The colour is optional only so that bags saved before colours were tracked
 * still load; such a line means "the product's default colour" and is
 * resolved through `lineColour`.
 */
export type BagItem = { id: string; size: string; colour?: string; quantity: number };

/**
 * The colour a bag line is really for. A line saved before colours were
 * tracked has no colour of its own and means the product's default colour, so
 * it still merges and still renders as that colour rather than as "no colour".
 */
export function lineColour(item: BagItem, product?: Product): string {
  return item.colour || product?.colour || '';
}

/** Stable identity of a bag line: the same product, size and colour is one line. */
export function lineKey(id: string, size: string, colour: string): string {
  return `${id}|${size}|${colour}`;
}
