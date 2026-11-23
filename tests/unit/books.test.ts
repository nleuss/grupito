import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { itemsToLines, linesToParagraphs, stripRunningLines, type PdfItem } from '../../src/books/pdf-layout';
import { parseEpub } from '../../src/books/epub';
import { capSections, estimateTokens, parsePlainText, passageAround, sentenceAt } from '../../src/books/text-utils';

/** Lay out text lines like a PDF page: baseline y decreasing, 14pt leading, 10pt font. */
function page(lines: (string | { text: string; x?: number; h?: number; gap?: number })[], top = 800): PdfItem[] {
  const items: PdfItem[] = [];
  let y = top;
  for (const l of lines) {
    const o = typeof l === 'string' ? { text: l } : l;
    y -= o.gap ?? 14;
    // Split each line into a couple of items, as PDFs usually do.
    const words = o.text.split(' ');
    const half = Math.ceil(words.length / 2);
    const a = words.slice(0, half).join(' ');
    const b = words.slice(half).join(' ');
    const x = o.x ?? 72;
    const h = o.h ?? 10;
    items.push({ str: a, x, y, w: a.length * 5, h });
    // A word space is about a quarter of the font size.
    if (b) items.push({ str: b, x: x + a.length * 5 + h * 0.27, y, w: b.length * 5, h });
  }
  return items;
}

describe('PDF layout reconstruction', () => {
  it('groups items into lines in reading order', () => {
    const lines = itemsToLines([
      { str: 'world', x: 110, y: 700, w: 25, h: 10 },
      { str: 'Hello', x: 72, y: 700.4, w: 25, h: 10 },
      { str: 'Second line', x: 72, y: 686, w: 55, h: 10 },
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Hello world', 'Second line']);
  });

  it('builds paragraphs: indentation, blank lines, headings, hyphenation, running headers', () => {
    const full = 'x'.repeat(10);
    const body = (n: number) => `Line ${n} of a long paragraph that fills the whole width of the page ${full}`;
    const pages = [1, 2, 3].map((n) =>
      itemsToLines(
        page([
          { text: 'Alice in Testland', h: 8 },
          { text: `Chapter ${n}`, h: 18, gap: 30 },
          { text: `It was a won- ${full}`.replace(` ${full}`, ''), x: 90, gap: 28 },
          `derful day and everyone in the village went outside to enjoy the sunshine ${full}`,
          'that morning.',
          { text: body(n), x: 90 },
          body(n + 10),
          { text: ['Then it rained.', 'Then it snowed.', 'Then it stopped.'][n - 1], gap: 30 },
          { text: String(n), h: 8, gap: 40 },
        ]),
      ),
    );
    const paras = linesToParagraphs(stripRunningLines(pages));
    expect(paras.filter((p) => p.h).map((p) => p.t)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    const first = paras.find((p) => !p.h)!;
    expect(first.t.startsWith('It was a wonderful day and everyone')).toBe(true);
    expect(first.t.endsWith('that morning.')).toBe(true);
    expect(paras.some((p) => p.t === 'Then it snowed.')).toBe(true);
    expect(paras.some((p) => /Alice in Testland/.test(p.t))).toBe(false);
    expect(paras.some((p) => /^\d+$/.test(p.t))).toBe(false);
    expect(first.p).toBe(1);
  });
});

function makeEpub(): Uint8Array {
  const xhtml = (title: string, body: string) =>
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body>${body}</body></html>`;
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'OEBPS/content.opf': strToU8(`<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>El libro de prueba</dc:title><dc:creator>Ana Autora</dc:creator><dc:language>es</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`),
    'OEBPS/nav.xhtml': strToU8(xhtml('Índice', '<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li><a href="text/ch1.xhtml">Capítulo uno</a></li><li><a href="text/ch2.xhtml#start">Capítulo dos</a></li></ol></nav>')),
    'OEBPS/text/ch1.xhtml': strToU8(xhtml('1', '<h1>Uno</h1><p>Érase una  vez un <em>pueblo</em> pequeño.</p><div><p>Párrafo anidado.</p></div><p>   </p>')),
    'OEBPS/text/ch2.xhtml': strToU8(xhtml('2', '<section><h2 id="start">Dos</h2><p>El final<br/>llegó pronto.</p></section>')),
  });
}

describe('EPUB', () => {
  it('reads metadata, spine order, TOC labels and paragraphs', () => {
    const book = parseEpub(makeEpub(), 'fallback');
    expect(book.title).toBe('El libro de prueba');
    expect(book.author).toBe('Ana Autora');
    expect(book.lang).toBe('es');
    expect(book.sections.map((s) => s.title)).toEqual(['Capítulo uno', 'Capítulo dos']);
    expect(book.sections[0].paragraphs).toEqual([{ t: 'Uno', h: 1 }, { t: 'Érase una vez un pueblo pequeño.' }, { t: 'Párrafo anidado.' }]);
    expect(book.sections[1].paragraphs[1]).toEqual({ t: 'El final llegó pronto.' });
  });

  it('rejects files that are not EPUBs', () => {
    expect(() => parseEpub(zipSync({ 'a.txt': strToU8('x') }), 'x')).toThrow(/Not an EPUB/);
  });
});

describe('plain text and helpers', () => {
  it('splits chapters and paragraphs', () => {
    const book = parsePlainText('Intro line.\n\nChapter 1\n\nFirst para\nwrapped.\n\nSecond para.\n\nCAPÍTULO II\n\nOtro.', 'Mi libro');
    expect(book.sections.map((s) => s.title)).toEqual(['Mi libro', 'Chapter 1', 'CAPÍTULO II']);
    expect(book.sections[1].paragraphs).toEqual([{ t: 'Chapter 1', h: 1 }, { t: 'First para wrapped.' }, { t: 'Second para.' }]);
  });

  it('finds the sentence around a word and the surrounding passage', () => {
    const text = 'First sentence here. The word is in this one! And a third.';
    expect(sentenceAt(text, text.indexOf('word'), 'en')).toBe('The word is in this one!');
    const paras = [{ t: 'A.' }, { t: 'B.' }, { t: 'C.' }];
    expect(passageAround(paras, 1)).toBe('A.\n\nB.\n\nC.');
  });

  it('caps long sections and estimates tokens', () => {
    const s = capSections([{ title: 'Long', paragraphs: Array.from({ length: 450 }, (_, i) => ({ t: `p${i}` })) }], 200);
    expect(s.map((x) => [x.title, x.paragraphs.length])).toEqual([
      ['Long (1)', 200],
      ['Long (2)', 200],
      ['Long (3)', 50],
    ]);
    expect(estimateTokens('a'.repeat(3600))).toBe(1000);
    expect(estimateTokens('日本語'.repeat(13))).toBe(30);
  });
});
