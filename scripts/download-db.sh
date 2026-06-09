#!/bin/bash
# Letölti a TENK saját GitHub release-ből a teljes (törvény + Korm. rendelet) DB-t.
# Ez a script a Fly.io volume-on NEM fut automatikusan (docker-entrypoint.sh nem hívja),
# a DB a perzisztens volume-ról jön. Katasztrófa-helyreállítási / új deployment tartalék.
set -e
VERSION=$(node -p "require('./package.json').version")
REPO="tenk-law-firm/tenk-legal-mcp"
TAG="v${VERSION}-decrees"
ASSET="database-hungarian-decrees.db.gz"
OUTPUT="data/database.db"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
echo "[download-db] Downloading TENK full database (statutes + decrees) from GitHub releases..."
echo "[download-db] URL: ${URL}"
mkdir -p data
curl -fSL --retry 3 --retry-delay 5 "$URL" | gunzip > "${OUTPUT}.tmp"
mv "${OUTPUT}.tmp" "$OUTPUT"
echo "[download-db] Done: ${OUTPUT}"
