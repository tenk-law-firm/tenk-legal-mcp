# Magyar Jogszabály MCP Szerver

**A Magyar Közlöny alternatívája az AI korszakban.**

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Kérdezz le **4 326 magyar jogszabályt** — a Ptk.-tól és Mt.-től a GDPR végrehajtási törvényig és a Btk.-ig — közvetlenül Claude-ból, Cursor-ból vagy bármely MCP-kompatibilis kliensből.

Ha jogi technológiát építesz, megfelelőségi eszközöket fejlesztesz, vagy magyar jogi kutatást végzel, ez a hitelesített referencia-adatbázisod.

Az [Ansvar Systems](https://ansvar.eu) Hungarian Law MCP szerverére épül — kiegészítve magyar citation parserrel, EU mapping-ekkel és KKV jogi skill rendszerrel.

---

## Gyors Indulás

### Távoli használat (telepítés nélkül)

**Endpoint:** `https://law.49-13-169-95.nip.io/mcp`

| Kliens | Csatlakozás |
|--------|-------------|
| **Claude.ai** | Settings > Connectors > Add Integration > URL beillesztése |
| **Claude Code** | `claude mcp add magyar-jogszabaly --transport http https://law.49-13-169-95.nip.io/mcp` |
| **Claude Desktop** | Lásd a konfigurációt lent |

**Claude Desktop** — add hozzá a `claude_desktop_config.json`-hoz:

```json
{
  "mcpServers": {
    "magyar-jogszabaly": {
      "type": "url",
      "url": "https://law.49-13-169-95.nip.io/mcp"
    }
  }
}
```

**Cursor / VS Code:**

```json
{
  "mcp.servers": {
    "magyar-jogszabaly": {
      "type": "http",
      "url": "https://law.49-13-169-95.nip.io/mcp"
    }
  }
}
```

---

## Példa kérdések

Csatlakozás után egyszerűen kérdezz természetes nyelven:

- *"Keresés 'adatvédelem' — milyen kötelezettségeket állapít meg a GDPR végrehajtási törvény?"*
- *"Hatályban van-e a Büntető Törvénykönyv 370. §-a?"*
- *"Hány nap szabadság jár egy 42 éves munkavállalónak?"*
- *"Melyik uniós irányelvet ültette át a Ptk. fogyasztóvédelmi fejezete?"*
- *"Ellenőrizd a hivatkozást: 2012. évi I. törvény 116. §"*
- *"Milyen engedély kell kávézó nyitásához?"*
- *"A partnerem 3 hónapja nem fizet, mit tegyek?"*

---

## Mit tartalmaz

| Kategória | Szám | Részletek |
|-----------|------|-----------|
| **Jogszabályok** | 4 326 | Teljes magyar joganyag az njt.hu-ról |
| **Rendelkezések** | 130 220 | Teljes szöveges keresés FTS5-tel |
| **EU kereszthivatkozások** | 109 | Irányelvek és rendeletek kapcsolva a magyar transzpozíciókhoz |
| **Adatbázis méret** | 282 MB | Optimalizált SQLite |
| **Frissítés** | Napi | Automatikus ellenőrzés az njt.hu-ról |

**Kizárólag hitelesített adat** — minden hivatkozás az njt.hu és Magyar Közlöny hivatalos forrásaiból. Nulla LLM-generált tartalom.

---

## Elérhető eszközök (13)

### Alap jogi kutatási eszközök (8)

| Eszköz | Leírás |
|--------|--------|
| `search_legislation` | FTS5 teljes szöveges keresés 130 220 rendelkezésben BM25 rangsorolással |
| `get_provision` | Konkrét rendelkezés lekérése jogszabály azonosító + szakaszszám alapján |
| `validate_citation` | Hivatkozás validálása az adatbázisban — magyar formátum támogatás (`"2012. évi I. törvény 116. §"`) |
| `build_legal_stance` | Hivatkozások aggregálása több jogszabályból egy jogi témához |
| `format_citation` | Hivatkozások formázása magyar konvenciók szerint (teljes/rövid/pinpoint) |
| `check_currency` | Jogszabály hatályosságának ellenőrzése (hatályos/módosított/hatályon kívül) |
| `list_sources` | Elérhető jogszabályok listája metaadatokkal |
| `about` | Szerver információk, adatbázis statisztikák |

### EU jog integrációs eszközök (5)

| Eszköz | Leírás |
|--------|--------|
| `get_eu_basis` | EU irányelvek/rendeletek lekérése, amelyek egy magyar jogszabály alapját képezik |
| `get_hungarian_implementations` | Magyar jogszabályok keresése, amelyek egy adott EU aktust implementálnak |
| `search_eu_implementations` | EU dokumentumok keresése magyar implementációs számokkal |
| `get_provision_eu_basis` | EU jogi hivatkozások egy konkrét rendelkezéshez |
| `validate_eu_compliance` | Magyar jogszabályok EU irányelveknek való megfelelőségének ellenőrzése |

---

## KKV Jogi Skill Könyvtár

Ez az MCP szerver a **[KKV Jogi Csapat](https://github.com/gergototh1/kkv-jogi-csapat)** skill rendszerrel együtt használható — 11 Claude Code skill, amely a magyar KKV-k leggyakoribb jogi kérdéseire ad választ.

### Hogyan működik

```
Felhasználó kérdése
  → kkv-jogi-router (routing 10 szakterületre)
    → Specializált skill (pl. kkv-munkajog)
      → MCP tool hívások (get_provision, check_currency, validate_citation)
        → Pontos jogszabályszöveg az adatbázisból
          → Strukturált válasz (kockázatszint + teendők + disclaimer)
```

### Elérhető skillek

| Skill | Terület |
|-------|---------|
| **kkv-jogi-router** | Orchestrátor — automatikus routing a megfelelő skill-hez |
| **kkv-munkajog** | Munkaszerződés, felmondás, szabadság, túlóra, home office (Mt.) |
| **kkv-ado** | ÁFA, TAO, KIVA, KATA, számlázás, adóellenőrzés (Art. + ÁFA tv.) |
| **kkv-gdpr** | Adatkezelési tájékoztató, DPIA, incidens, cookie (Infotv. + GDPR) |
| **kkv-szerzodes** | ÁSZF audit, szavatosság, NDA, freelancer szerződés (Ptk.) |
| **kkv-cegjog** | Kft./Bt. alapítás, taggyűlés, törzstőke, EV→Kft. átmenet (Ctv.) |
| **kkv-fogyasztovedelmi** | Webshop, elállási jog, jótállás, marketplace (Fgytv.) |
| **kkv-koveteleskezeles** | Fizetési meghagyás, végrehajtás, késedelmi kamat (Fmhtv. + Vht.) |
| **kkv-szellemi-tulajdon** | Védjegy, szerzői jog, szoftver IP, domain viták (Szjt. + Vt.) |
| **kkv-ingatlan** | Székhelyszolgáltatás, bérleti szerződés, telephely (Ptk. + Ctv.) |
| **kkv-engedelyek** | Működési engedély, vendéglátás, NTAK, HACCP (Kertv.) |

**Telepítés:** [github.com/gergototh1/kkv-jogi-csapat](https://github.com/gergototh1/kkv-jogi-csapat)

---

## Adatforrások és Frissesség

Minden tartalom hiteles magyar jogi adatbázisokból származik:

- **[njt.hu](https://njt.hu/)** — Nemzeti Jogszabálytár, a hivatalos konszolidált magyar jogi adatbázis
- **[Magyar Közlöny](https://magyarkozlony.hu/)** — Hivatalos Közlöny (elsődleges jogalkotási kiadvány)
- **[EUR-Lex](https://eur-lex.europa.eu/)** — Az EU hivatalos jogi adatbázisa (csak metaadatok)

---

## Fontos Jogi Nyilatkozatok

### Jogi tanácsadás

> **EZ AZ ESZKÖZ NEM MINŐSÜL JOGI TANÁCSADÁSNAK**
>
> A jogszabályszövegek az njt.hu / Magyar Közlöny hivatalos kiadványaiból származnak. Mindazonáltal:
> - Ez egy **kutatási eszköz**, nem helyettesíti a szakszerű jogi tanácsadást
> - **Kritikus hivatkozásokat ellenőrizd** az elsődleges forrásokon bírósági beadványokhoz
> - **EU kereszthivatkozások** a magyar jogszabályszövegből vannak kinyerve, nem az EUR-Lex teljes szövegéből
> - **Mindig erősítsd meg** a hatályos állapotot az njt.hu-n, mielőtt szakmai célra hivatkoznál

### Titoktartás

A lekérdezések az MCP protokollon keresztül mennek. Bizalmas vagy ügyvédi titoktartás alá eső ügyeknél használj helyi telepítést.

---

## Fejlesztés

### Telepítés

```bash
git clone https://github.com/gergototh1/magyar-jogszabaly-mcp
cd magyar-jogszabaly-mcp
npm install
npm run build
```

### Adatbázis kezelés

```bash
npm run build:db            # SQLite adatbázis újraépítése
```

---

## Saját javítások az alap Ansvar szerveren

Ez a fork az [Ansvar Systems Hungarian Law MCP](https://github.com/Ansvar-Systems/Hungarian-law-mcp) szerverre épül, a következő kiegészítésekkel:

- **Magyar citation parser** — `validate_citation("2012. évi I. törvény 116. §")` felismerés
- **Ptk. kettőspontos section** — `6:272. §` formátum kezelése
- **Magyar normalized output** — `"doc.title NNN. §"` formátum
- **EU mapping seed** — 14 irányelv/rendelet (GDPR, Consumer Rights, ePrivacy, VAT, stb.)
- **format_citation DB lookup** — teljes cím feloldás az adatbázisból
- **KKV jogi skill könyvtár** — 11 skill magyar KKV-knak

---

## Licensz

Apache License 2.0. Lásd [LICENSE](./LICENSE).

### Adat licenszek

- **Jogszabályok:** Magyar Kormány / njt.hu (közkincs)
- **EU metaadatok:** EUR-Lex (EU közkincs)

---

## Eredeti projekt

Ez a projekt az [Ansvar Systems](https://ansvar.eu) (Stockholm, Svédország) Hungarian Law MCP szerverének fork-ja.
