// Text clean-up shared by all subtitle parsers.

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lrm: '',
  rlm: '',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  iexcl: '¡',
  iquest: '¿',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Turn a raw cue payload (VTT/SRT/HTML-ish) into clean display text:
 * drops ruby annotations, tags, ASS override blocks, bidi control marks and empty lines.
 */
export function cleanCueText(raw: string): string {
  let s = raw
    .replace(/<(rt|rp)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/\\N/g, '\n');
  s = decodeEntities(s).replace(/[‎‏‪-‮⁦-⁩]/g, '');
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Single-line version of a cue, used as translation input. */
export function cueToSingleLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}
