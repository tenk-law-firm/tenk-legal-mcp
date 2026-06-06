#!/bin/sh
# scripts/cron-run.sh — Supercronic cron-job wrapper
#
# Futtatja a cron-update.js-t, majd az exit-kód alapján dönt:
#   exit 0  → no-op (DB friss) — semmi teendő, konténer fut tovább
#   exit 1  → gate-hiba — semmi teendő, SZERVER NEM ÁLL LE (loop-védelem!)
#   exit 2  → DB frissítve, restart kell — SIGTERM PID 1-re (az entrypoint),
#             ami a konténert leállítja; a fly.toml [[restart]] policy="always"
#             gondoskodik az újraindításról az új DB-vel.
#
# Miért PID 1 elsődlegesen: a Fly a PID 1 leállását figyeli a gép-restart
# kiváltásához. Az entrypoint wait()-je amúgy is a szerver-PID-re vár,
# de a legmegbízhatóbb, ha közvetlenül PID 1-et állítjuk le.

CRON_UPDATE="${CRON_UPDATE:-/app/dist/scripts/cron-update.js}"

echo "[cron-run $(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting cron-update..."

node "$CRON_UPDATE"
EXIT_CODE=$?

echo "[cron-run $(date -u +%Y-%m-%dT%H:%M:%SZ)] cron-update exited with code $EXIT_CODE"

if [ "$EXIT_CODE" -eq 2 ]; then
  echo "[cron-run $(date -u +%Y-%m-%dT%H:%M:%SZ)] DB updated — sending SIGTERM to PID 1 (entrypoint) to trigger restart."
  kill -TERM 1 2>/dev/null || true

elif [ "$EXIT_CODE" -eq 0 ]; then
  echo "[cron-run $(date -u +%Y-%m-%dT%H:%M:%SZ)] No update needed — server continues running."

else
  # exit 1 (gate-hiba) vagy egyéb hiba: NEM indítjuk újra a szervert.
  echo "[cron-run $(date -u +%Y-%m-%dT%H:%M:%SZ)] Update failed (exit $EXIT_CODE) — server left running, DB untouched."
fi
