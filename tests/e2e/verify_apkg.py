"""Import an .apkg into a fresh Anki collection with Anki's own Python library and print a JSON summary.

Usage: python verify_apkg.py deck.apkg
"""
import json
import os
import sys
import tempfile

from anki.collection import Collection

path = os.path.abspath(sys.argv[1])
tmp = tempfile.mkdtemp()
col = Collection(os.path.join(tmp, "collection.anki2"))
try:
    try:
        from anki.collection import ImportAnkiPackageOptions, ImportAnkiPackageRequest

        col.import_anki_package(ImportAnkiPackageRequest(package_path=path, options=ImportAnkiPackageOptions(with_scheduling=False)))
    except ImportError:
        from anki.importing.apkg import AnkiPackageImporter

        AnkiPackageImporter(col, path).run()

    note_ids = col.find_notes("")
    notes = [col.get_note(nid) for nid in note_ids]
    media_dir = col.media.dir()
    summary = {
        "notes": len(notes),
        "cards": col.card_count(),
        "decks": sorted(d.name for d in col.decks.all_names_and_ids()),
        "models": sorted(m.name for m in col.models.all_names_and_ids()),
        "first": dict(notes[0].items()) if notes else None,
        "media_files": len([f for f in os.listdir(media_dir) if not f.startswith(".")]) if os.path.isdir(media_dir) else 0,
    }
    print(json.dumps(summary, ensure_ascii=False))
finally:
    col.close()
