#!/bin/bash
# Javító újratöltés a parser-fix (oldal-keret szennyezés) és az isDecreeRepealed-fix után.
#   PHASE L: a 130 szennyezett törvény-seed törlése + célzott újra-fetch
#            (--resume: a többi ~4200 seed-skip, csak a hiányzók töltődnek)
#   PHASE D: az ÖSSZES rendelet-seed törlése + teljes 1990–2026 újra-discovery
#            (resume NÉLKÜL; --skip-fetch: a discovery által frissen cache-elt
#             oldalból parse-ol, nincs dupla letöltés)
set -uo pipefail
cd "$(dirname "$0")/.."

echo "===== PHASE L: szennyezett törvény-seedek ($(wc -l < data/contaminated-laws.txt | tr -d ' ') db) ====="
while IFS= read -r id; do
  [ -n "$id" ] && rm -f "data/seed/${id}.json"
done < data/contaminated-laws.txt

npm run ingest -- --full --in-force-only --resume --page-size 50
rc=$?
if [ $rc -ne 0 ]; then
  echo "PHASE L FAILED (exit $rc) — a rendelet-fázist nem indítom, hogy a hiba ne maradjon észrevétlen."
  exit 1
fi
# GATE: mind a törölt seednek újra léteznie kell, különben a dokumentum
# kiesne az újraépített DB-ből.
MISSING=""
while IFS= read -r id; do
  [ -n "$id" ] && [ ! -f "data/seed/${id}.json" ] && MISSING="$MISSING $id"
done < data/contaminated-laws.txt
if [ -n "$MISSING" ]; then
  echo "PHASE L GATE FAILED — hiányzó seedek:$MISSING"
  exit 1
fi
echo "===== PHASE L KÉSZ (mind a $(wc -l < data/contaminated-laws.txt | tr -d ' ') seed újra megvan) ====="

echo "===== PHASE D: rendelet-seedek törlése + teljes újra-discovery 1990–2026 ====="
find data/seed -name 'hu-decree-*.json' -delete

FAILED_YEARS=""
for YEAR in $(seq 1990 2026); do
  echo "===== ÉV: $YEAR ====="
  npm run ingest -- --decrees --decree-year "$YEAR" --decrees-in-force-only --skip-fetch
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "WARN: év $YEAR exit code $rc"
    FAILED_YEARS="$FAILED_YEARS $YEAR"
  fi
done

echo "===== PHASE D KÉSZ ====="
if [ -n "$FAILED_YEARS" ]; then
  echo "HIBÁS ÉVEK:$FAILED_YEARS"
  exit 1
fi
echo "===== MINDEN FÁZIS SIKERES ====="
