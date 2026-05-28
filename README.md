# VM-tipset 2026 ⚽

Intern satsningspool för Fotbolls-VM 2026 (USA/Kanada/Mexiko, 11 juni – 19 juli).

## Funktioner

- Spelarna registrerar sig själva och väljer lag via publika webbsidan
- Swish-betalningsprompt efter registrering
- Automatisk pengaomfördelning vid grupputslag och slutspelsresultat
- Live-vy med aktuellt satsningsbelopp per lag, topplista och per-spelare-vy
- Admin-panel för att hantera resultat, stänga satsningar och nollställa

## Regler i korthet

| Fas | Vad händer |
|-----|-----------|
| Gruppspel | Utslagna lags pengar → jämnt till spelare med vidare-lag i samma grupp |
| R32 / R16 / QF | Förlorarlagets pengar → till vinnarlaget (proportionellt) |
| Semifinal | 75 % till vinnarlaget · 25 % följer med till bronsmatchen |
| Bronsmatch | Hela bronspotten → till de som satsat på bronsmedaljören |
| Final | Hela potten delas · vinnarsatsning = dubbelt mot förlorarsatsning (per spelare) |

## Starta med Docker

```bash
cp .env.example .env        # Ändra ADMIN_PASSWORD om du vill
docker compose up -d
```

Besök `http://<din-ip>:3000` — admin på `http://<din-ip>:3000/admin`.

## Starta lokalt (Node.js v22+)

```bash
npm install
npm start
```

## Miljövariabler

| Variabel | Standard | Beskrivning |
|----------|----------|-------------|
| `ADMIN_PASSWORD` | `vm2026` | Lösenord till admin-panelen |
| `PORT` | `3000` | Port appen lyssnar på |
| `DB_PATH` | `data/vmpool.db` | Sökväg till SQLite-databasen |

---

*Skapad med hjälp av [Claude](https://claude.ai) — Anthropics AI-assistent*
