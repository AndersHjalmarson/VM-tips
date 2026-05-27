# VM-poolen 2026 — Projektkontext för Claude

## Vad är det här?

Intern satsningspool för Östgötatrafikens personal inför Fotbolls-VM 2026
(USA/Kanada/Mexiko, 11 juni – 19 juli). Spelarna registrerar sig själva via
webbsidan, väljer lag och Swishar sin satsning till Anders Hjalmarson (0708-883225).

GitHub: https://github.com/AndersHjalmarson/VM-tips

---

## Köra projektet

```bash
# Lokalt (Node.js v22+)
npm install
npm start          # använder --experimental-sqlite flaggan
# → http://localhost:3000      (publik sida)
# → http://localhost:3000/admin (admin-panel)

# Med Docker
docker compose up -d
```

**Viktigt:** Appen använder Node.js inbyggda `node:sqlite` (ingen native-kompilering).
Kräver Node.js v22 eller senare. Startkommandot MÅSTE ha flaggan `--experimental-sqlite`
(definierat i package.json scripts).

Admin-lösenord: `vm2026` (kan ändras via env-variabeln `ADMIN_PASSWORD`).

---

## Teknikstack

| Del | Val |
|-----|-----|
| Backend | Node.js + Express |
| Databas | SQLite via `node:sqlite` (inbyggd i Node, ingen extra package) |
| Frontend | Vanilla HTML/CSS/JS (ingen byggsteg) |
| Container | Docker + docker-compose |
| Databas-fil | `data/vmpool.db` (skapas automatiskt, ignoreras av git) |

---

## Filstruktur

```
vm-poolen/
├── server.js                  # Express-server, entrypoint
├── src/
│   ├── database.js            # DB-init, lag-seed, withTransaction()-helper
│   ├── redistribution.js      # All pengaomfördelningslogik
│   └── routes/
│       ├── api.js             # Publika API-endpoints
│       └── admin.js           # Admin-endpoints (kräver X-Admin-Token header)
├── public/
│   ├── index.html             # Publik sida (registrering + live-vy)
│   ├── admin.html             # Admin-panel
│   ├── css/styles.css
│   └── js/
│       ├── main.js            # Publik sida JS
│       └── admin.js           # Admin-panel JS
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## Spelregler och pengaomfördelning

### Satsningsbelopp
- **Gruppsatsning:** 20 kr/lag (väljs under gruppspelet)
- **Slutspelssatsning:** 50 kr/lag (öppnar efter gruppspelet, bara vidare-lag)

### Omfördelningslogik (implementerad i `src/redistribution.js`)

**Gruppspel** (`processPartialGroupResults`):
- Stöder **gradvis registrering**: admin kan markera ett lag i taget som Vidare/Utslaget
- Utslagna lags `current_amount` → nollställs och läggs i en **grupp-pool** (`group_A_pending` i settings)
- Poolen fördelas **jämnt per spelare** (ej per satsning) på spelare med satsningar på vidare-lag
  *först när alla fyra lag i gruppen har bekräftad status*
- Om en spelare har flera vidare-lag delas deras andel lika mellan deras satsningar
- Idempotent: om ett lag redan är markerat i DB ignoreras det vid ny körning

**Sextondels/Åttondels/Kvartsfinaler** (`_processRegularKnockout`):
- Förlorarlagets `current_amount` → fördelas **proportionellt** till vinnarlaget
  (proportionellt mot befintlig `current_amount` hos vinnarbetsarna)

**Semifinal** (`_processSemifinal`):
- 75 % av förlorarlagets pool → proportionellt till vinnarlaget
- 25 % **stannar kvar** på förlorarnas satsningar (följer med till bronsmatchen)
- Förlorarlaget markeras INTE som eliminerat

**Bronsmatch** (`_processBronze`):
- Hela kombinerade potten (de 25 % från båda semifinal-förlorarna) poolas
- Allt fördelas proportionellt till de som satsat på bronsmedaljören
- Förlorarlaget nollställs och markeras eliminerat

**Final** (`_processFinal`):
- Alla återstående satsningar på båda finallagen poolas
- Fördelas **2:1 per spelare**: varje vinnare-spelare får 2 andelar,
  varje förlorare-spelare får 1 andel
- Om en spelare har flera satsningar på ett lag delas deras andel lika

### Viktiga detaljer
- `withTransaction(fn)` i `database.js` ersätter better-sqlite3:s `db.transaction()`
  (node:sqlite saknar inbyggd transaction-helper)
- Alla omfördelningar är idempotent-skyddade (dubbel-körning blockeras)

---

## Databas-schema

```sql
players   (id, name, created_at)
teams     (id, name, group_name, eliminated, advanced_to_knockouts)
bets      (id, player_id, team_id, original_amount, current_amount,
           bet_type['initial'|'knockout'], created_at)
           UNIQUE(player_id, team_id, bet_type)
matches   (id, round['r32'|'r16'|'qf'|'sf'|'bronze'|'final'],
           team1_id, team2_id, winner_id, played_at, created_at)
settings  (key, value)
           -- 'group_A_pending' .. 'group_L_pending' → väntande pool-belopp (sträng)
           -- 'group_bets_open'   → 'true'/'false'
           -- 'knockout_bets_open' → 'true'/'false'
```

---

## API-översikt

### Publika endpoints (`/api/`)
| Method | Path | Beskrivning |
|--------|------|-------------|
| GET | `/api/groups` | Alla 12 grupper med lag och aktuell pott |
| GET | `/api/players` | Alla spelare med satsningar och summor |
| GET | `/api/player/:name` | Slå upp enskild spelare |
| GET | `/api/summary` | Total pott, antal spelare, fas-info, registreringsstatus |
| GET | `/api/matches` | Alla slutspelsmatcher |
| POST | `/api/register` | Självregistrering `{name, team_ids[], bet_type}` |

### Admin-endpoints (`/admin/api/`, kräver `X-Admin-Token: <lösenord>`)
| Method | Path | Beskrivning |
|--------|------|-------------|
| POST | `/admin/api/auth` | Verifiera lösenord |
| GET/POST | `/admin/api/players` | Lista/skapa spelare |
| DELETE | `/admin/api/players/:id` | Ta bort spelare + satsningar |
| GET | `/admin/api/bets` | Lista alla satsningar |
| POST | `/admin/api/bets/bulk` | Lägg till flera satsningar åt en spelare |
| DELETE | `/admin/api/bets/:id` | Ta bort satsning |
| GET | `/admin/api/groups/status` | Vilka grupper är behandlade |
| POST | `/admin/api/groups/:group/results` | Gradvis gruppresultat `{advanced_team_ids[], eliminated_team_ids[]}` |
| GET/POST | `/admin/api/teams` | Lista lag / hämta för dropdown |
| POST | `/admin/api/matches` | Skapa slutspelsmatch |
| POST | `/admin/api/matches/:id/result` | Registrera matchresultat `{winner_id}` |
| GET | `/admin/api/matches` | Lista matcher |
| GET/POST | `/admin/api/registration-status` | Visa/ändra om satsningar är öppna |
| POST | `/admin/api/reset` | Nollställ alla resultat (behåller spelare/satsningar) |

---

## VM 2026 — Turneringsformat

- 48 lag, 12 grupper (A–L) med 4 lag vardera
- Topp 2 från varje grupp + 8 bästa tredjeplatsen → 32 lag i slutspel
- Rundor: R32 (sextondels) → R16 (åttondels) → QF (kvartsfinaler)
  → SF (semifinaler) → Bronsmatch + Final

### Grupper (lottade)
A: Mexiko, Sydafrika, Sydkorea, Tjeckien
B: Kanada, Bosnien-Hercegovina, Qatar, Schweiz
C: Brasilien, Marocko, Haiti, Skottland
D: USA, Paraguay, Australien, Turkiet
E: Tyskland, Curaçao, Elfenbenskusten, Ecuador
F: Nederländerna, Japan, **Sverige**, Tunisien
G: Belgien, Egypten, Iran, Nya Zeeland
H: Spanien, Kap Verde, Saudiarabien, Uruguay
I: Frankrike, Senegal, Irak, Norge
J: Argentina, Algeriet, Österrike, Jordanien
K: Portugal, DR Kongo, Uzbekistan, Colombia
L: England, Kroatien, Ghana, Panama

---

## Admin-flöde under turneringen

1. **Innan start:** Lägg till spelare och registrera satsningar (eller låt dem
   registrera sig själva). Stäng gruppsatsningar när anmälningstiden löper ut.

2. **Efter gruppspelet:** För varje grupp A–L: gå till Gruppresultat i admin,
   kryssa i vilka lag som gick vidare (2 eller 3), klicka Behandla.
   Öppna sedan slutspelssatsningar.

3. **Slutspelsomgångar:** Skapa matcher (välj lag + omgång), registrera
   vinnare direkt när matchen är spelad → omfördelning sker automatiskt.

4. **Semifinaler:** Registrera som vanligt — 25 % stannar automatiskt kvar
   på förlorarnas satsningar inför bronsmatchen.

5. **Bronsmatch + Final:** Registrera som vanligt — speciell logik hanteras
   automatiskt baserat på `round`-värdet.

---

## Kända begränsningar / framtida förbättringar

- Ingen per-användare-autentisering (spelare identifieras bara med namn)
- Admin-lösenordet skickas i klartext som HTTP-header (OK för internt nätverk)
- Ingen automatisk backup av databasen
- Publika sidan uppdateras via polling var 30:e sekund (inte websockets)
