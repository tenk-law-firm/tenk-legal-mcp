#!/bin/sh
# docker-entrypoint.sh — két process supervisor egy konténerben
#
# 1. Supercronic indul háttérben (heti DB-frissítés)
# 2. HTTP-szerver indul ELŐTÉRBEN (ez tartja életben a konténert)
#
# Ha a szerver leáll (akár cron-run.sh SIGTERM-je miatt, akár hiba miatt),
# a script kilép — a Fly restart-policy újraindítja a gépet.

# set -e szándékosan NINCS — a Supercronic-indítási hiba nem állíthatja meg
# a HTTP-szerver elindítását (szerver = kritikus fő process, cron = másodlagos).

SERVER_PID_FILE="/tmp/http-server.pid"
export SERVER_PID_FILE

echo "[entrypoint] Starting Supercronic in background..."
/usr/local/bin/supercronic /app/crontab &
SUPERCRONIC_PID=$!
echo "[entrypoint] Supercronic PID: $SUPERCRONIC_PID"

echo "[entrypoint] Starting HTTP server in foreground..."
node /app/dist/src/http-server.js &
SERVER_PID=$!
echo "$SERVER_PID" > "$SERVER_PID_FILE"
echo "[entrypoint] HTTP server PID: $SERVER_PID (written to $SERVER_PID_FILE)"

# Wait for the HTTP server — ha leáll, a script is kilép (Fly újraindítja)
wait $SERVER_PID
EXIT_CODE=$?
echo "[entrypoint] HTTP server exited with code $EXIT_CODE — container will restart."
exit $EXIT_CODE
