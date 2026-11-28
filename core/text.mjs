// Text helpers shared by the store and the outputs: plain text of a posting description and its stored excerpt.

export const EXCERPT_CHARS = 1200;

/** Plain text: tags and entities removed, whitespace collapsed. */
export const stripHtml = (s) => String(s ?? '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();

/** Plain-text excerpt of at most `max` characters, cut at a word boundary with an ellipsis. */
export function excerptOf(text, max = EXCERPT_CHARS) {
  const t = stripHtml(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-]+$/, '') + '…';
}

/** The text fields a store keeps for a read item: { excerpt?, description? } (description only with keepDescription). Empty when the item has no text. */
export function textOf(it, { keepDescription = false } = {}) {
  const plain = it?.description ? stripHtml(it.description) : '';
  if (!plain) return {};
  return { excerpt: excerptOf(plain), ...(keepDescription ? { description: plain } : {}) };
}

/** Splits a stored posting record into the slim record (what the postings table keeps) and its text ({ excerpt, description? } or null). */
export function splitText(rec) {
  const { excerpt, description, ...slim } = rec;
  return { slim, text: excerpt ? { excerpt, ...(description ? { description } : {}) } : null };
}
