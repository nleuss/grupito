import type { VocabItem } from '../shared/types';

function cell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function vocabToCsv(items: VocabItem[]): string {
  const header = ['text', 'kind', 'language', 'translation', 'reading', 'lemma', 'definition', 'context', 'context_translation', 'source_title', 'source_url', 'source_time', 'status', 'notes', 'created'];
  const rows = items.map((v) =>
    [
      v.text,
      v.kind,
      v.lang,
      v.translation,
      v.reading,
      v.lemma,
      v.definition,
      v.context,
      v.contextTranslation,
      v.source?.title,
      v.source?.url,
      v.source?.time != null ? v.source.time.toFixed(1) : '',
      v.status,
      v.notes,
      new Date(v.createdAt).toISOString(),
    ]
      .map(cell)
      .join(','),
  );
  // BOM so spreadsheet apps detect UTF-8.
  return '﻿' + [header.join(','), ...rows].join('\r\n');
}
