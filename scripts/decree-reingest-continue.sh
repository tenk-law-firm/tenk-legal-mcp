#!/bin/bash
# Phase D folytatás: rendelet-újra-discovery a megadott évtől 2026-ig.
# Az 1990–2006 seedek készek — azokat NEM érinti (nincs seed-törlés).
# Évenként legfeljebb 3 próbálkozás; a --resume miatt egy részben kész év
# újrafutása csak a hiányzó rendeleteket parse-olja újra.
set -u
cd "$(dirname "$0")/.."

START_YEAR="${1:-2007}"
echo "===== PHASE D FOLYTATÁS: ${START_YEAR}–2026 ====="

FAILED_YEARS=""
for YEAR in $(seq "$START_YEAR" 2026); do
  ok=0
  for ATTEMPT in 1 2 3; do
    echo "===== ÉV: $YEAR (próbálkozás: $ATTEMPT) ====="
    npm run ingest -- --decrees --decree-year "$YEAR" --decrees-in-force-only --skip-fetch --resume
    rc=$?
    if [ $rc -eq 0 ]; then ok=1; break; fi
    echo "WARN: év $YEAR próbálkozás $ATTEMPT sikertelen (exit $rc) — 30s múlva újra"
    sleep 30
  done
  if [ $ok -ne 1 ]; then
    echo "HIBA: év $YEAR 3 próbálkozás után is sikertelen"
    FAILED_YEARS="$FAILED_YEARS $YEAR"
  fi
done

echo "===== PHASE D KÉSZ ====="
if [ -n "$FAILED_YEARS" ]; then
  echo "HIBÁS ÉVEK:$FAILED_YEARS"
  exit 1
fi
echo "===== PHASE D SIKERES ====="
