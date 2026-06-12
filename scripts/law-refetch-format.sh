#!/bin/bash
# Törvény-korpusz újra-fetch a sortörés-őrző parserrel (njt-hű tördelés).
# A rendelet-seedeket NEM érinti (azokat a reparse-seeds-from-cache frissíti).
#
# Lépések:
#   0. teljes seed-backup tar (visszaállítási alap)
#   1. a nem-decree seed-id lista pillanatképe (gate-hez)
#   2. law seedek törlése (hu-alaptorveny kivételével)
#   3. teljes law ingest --full --resume (mindent frissen fetchel + cache-el)
#   4. alaptörvény külön ingest
#   5. alias-ikrek regenerálása a kurált seedekből
#   6. GATE: minden korábbi seed-id újra létezik; a hiányzók visszaállítása
#      a backupból + riport ("soha csendes hiba")
set -u
cd "$(dirname "$0")/.."

STAMP=$(date +%Y%m%d-%H%M)
BACKUP="data/seed-backup-${STAMP}.tar.gz"
BEFORE="data/law-seed-ids-before.txt"

echo "===== LAW REFETCH START ====="
echo "--- 0. backup: $BACKUP"
tar -czf "$BACKUP" -C data seed

echo "--- 1. pillanatkép"
ls data/seed | grep -v '^hu-decree-' | sed 's/\.json$//' > "$BEFORE"
echo "    $(wc -l < "$BEFORE" | tr -d ' ') nem-decree seed"

echo "--- 2. law seedek törlése (hu-alaptorveny marad)"
ls data/seed | grep -v '^hu-decree-' | grep -v '^hu-alaptorveny\.json$' | while IFS= read -r f; do
  rm -f "data/seed/$f"
done

echo "--- 3. teljes law ingest (friss fetch, ~1.5-3 óra)"
npm run ingest -- --full --resume
rc=$?
if [ $rc -ne 0 ]; then echo "WARN: law ingest exit code $rc — a gate dönti el, mi hiányzik"; fi

echo "--- 4. alaptörvény frissítése"
npm run ingest -- --alaptorveny || echo "WARN: alaptörvény ingest hiba"

echo "--- 5. alias-ikrek regenerálása"
python3 - << 'PYEOF'
import json
pairs = [
    ('act-c-2003-electronic-communications', 'hu-law-2003-100-00-00'),
    ('act-lxiii-1999-public-procurement',    'hu-law-2015-143-00-00'),
]
import tarfile, io, os
for curated_id, alias_id in pairs:
    try:
        curated = json.load(open(f'data/seed/{curated_id}.json'))
    except FileNotFoundError:
        print(f'  WARN: kurált seed hiányzik: {curated_id} — alias kihagyva: {alias_id}')
        continue
    alias_path = f'data/seed/{alias_id}.json'
    # metaadat a korábbi alias seedből, ha a backupban megvan — különben a kuráltból
    meta = {}
    try:
        old = json.load(open(alias_path))
        meta = {k: old[k] for k in ('title','title_en','short_name','status','issued_date','in_force_date','url','description') if k in old}
    except FileNotFoundError:
        meta = {k: curated[k] for k in ('title','title_en','short_name','status','issued_date','in_force_date','url','description') if k in curated}
    seed = {'id': alias_id, 'type': 'statute', **meta,
            'provisions': curated['provisions'], 'definitions': curated.get('definitions', [])}
    with open(alias_path, 'w') as f:
        json.dump(seed, f, ensure_ascii=False, indent=2); f.write('\n')
    print(f'  alias: {alias_id} ({len(seed["provisions"])} prov, forrás: {curated_id})')
PYEOF

echo "--- 6. GATE: hiányzó seedek visszaállítása a backupból"
MISSING=0
RESTORED=""
while IFS= read -r id; do
  if [ ! -f "data/seed/${id}.json" ]; then
    MISSING=$((MISSING+1))
    if tar -xzf "$BACKUP" -C data "seed/${id}.json" 2>/dev/null; then
      RESTORED="$RESTORED $id"
    else
      echo "GATE HIBA: ${id} hiányzik és a backupból sem állítható vissza!"
    fi
  fi
done < "$BEFORE"

if [ $MISSING -gt 0 ]; then
  echo "GATE: $MISSING seed hiányzott az újrafetch után — visszaállítva a backupból (RÉGI tördeléssel):"
  for id in $RESTORED; do echo "  - $id"; done
else
  echo "GATE: minden korábbi seed-id újra létezik."
fi

echo "===== LAW REFETCH KÉSZ ====="
