// Minimal HLS playlist parsing for subtitle renditions (used by Disney+ and generic HLS players).

export interface HlsRendition {
  groupId: string;
  lang: string;
  name: string;
  uri: string;
  forced: boolean;
  isDefault: boolean;
  characteristics: string;
}

export function parseAttributeList(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

export function isHlsMaster(text: string): boolean {
  return text.includes('#EXTM3U') && (text.includes('#EXT-X-STREAM-INF') || text.includes('#EXT-X-MEDIA:'));
}

/** Subtitle renditions declared in a master playlist (#EXT-X-MEDIA:TYPE=SUBTITLES). */
export function parseHlsMaster(text: string, baseUrl: string): HlsRendition[] {
  const out: HlsRendition[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:')) continue;
    const a = parseAttributeList(line.slice('#EXT-X-MEDIA:'.length));
    if (a.TYPE !== 'SUBTITLES' || !a.URI) continue;
    let uri: string;
    try {
      uri = new URL(a.URI, baseUrl).href;
    } catch {
      continue;
    }
    out.push({
      groupId: a['GROUP-ID'] ?? '',
      lang: a.LANGUAGE ?? 'und',
      name: a.NAME ?? a.LANGUAGE ?? 'Subtitles',
      uri,
      forced: a.FORCED === 'YES',
      isDefault: a.DEFAULT === 'YES',
      characteristics: a.CHARACTERISTICS ?? '',
    });
  }
  // The same language often appears once per group (e.g. per CDN or codec); keep one per name+lang.
  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.lang}|${r.name}|${r.forced}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Segment URLs of a media playlist. */
export function parseHlsMedia(text: string, baseUrl: string): string[] {
  const urls: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      urls.push(new URL(line, baseUrl).href);
    } catch {
      /* ignore malformed */
    }
  }
  return urls;
}
