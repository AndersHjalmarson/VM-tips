const express = require('express');
const router = express.Router();
const { db, withTransaction } = require('../database');
const { processPartialGroupResults, processKnockoutMatch } = require('../redistribution');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'vm2026';

// Autentiseringsmiddleware
function requireAuth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Ogiltig adminkod' });
  }
  next();
}

// Verifiera lösenord
router.post('/auth', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true, token: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: 'Fel lösenord' });
  }
});

// --- Spelare ---

router.get('/players', requireAuth, (req, res) => {
  const players = db.prepare('SELECT * FROM players ORDER BY name').all();
  res.json(players);
});

router.post('/players', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Namn krävs' });
  try {
    const result = db.prepare('INSERT INTO players (name) VALUES (?)').run(name.trim());
    res.json({ id: result.lastInsertRowid, name: name.trim() });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Spelare finns redan' });
    throw e;
  }
});

router.delete('/players/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM bets WHERE player_id = ?').run(req.params.id);
  db.prepare('DELETE FROM players WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Satsningar ---

router.get('/bets', requireAuth, (req, res) => {
  const bets = db.prepare(`
    SELECT b.id, b.player_id, p.name AS player_name,
           b.team_id, t.name AS team_name, t.group_name,
           b.original_amount, b.current_amount, b.bet_type, b.created_at
    FROM bets b
    JOIN players p ON p.id = b.player_id
    JOIN teams t ON t.id = b.team_id
    ORDER BY p.name, t.group_name, t.name
  `).all();
  res.json(bets);
});

// Lägg till en satsning
router.post('/bets', requireAuth, (req, res) => {
  const { player_id, team_id, bet_type } = req.body;
  const amount = bet_type === 'knockout' ? 50 : 20;

  if (!player_id || !team_id) return res.status(400).json({ error: 'player_id och team_id krävs' });

  const validType = ['initial', 'knockout'].includes(bet_type);
  if (!validType) return res.status(400).json({ error: 'bet_type måste vara initial eller knockout' });

  if (bet_type === 'knockout') {
    const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(team_id);
    if (!team?.advanced_to_knockouts) {
      return res.status(400).json({ error: 'Laget har inte gått vidare till slutspelet' });
    }
  }

  try {
    const result = db.prepare(
      'INSERT INTO bets (player_id, team_id, original_amount, current_amount, bet_type) VALUES (?, ?, ?, ?, ?)'
    ).run(player_id, team_id, amount, amount, bet_type);
    res.json({ id: result.lastInsertRowid, amount });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Satsning finns redan' });
    throw e;
  }
});

// Bulk-satsning: flera lag åt gången för en spelare
router.post('/bets/bulk', requireAuth, (req, res) => {
  const { player_id, team_ids, bet_type } = req.body;
  const amount = bet_type === 'knockout' ? 50 : 20;

  if (!player_id || !Array.isArray(team_ids) || team_ids.length === 0) {
    return res.status(400).json({ error: 'player_id och team_ids[] krävs' });
  }

  const errors = [];
  const added = [];

  const insertOne = db.prepare(
    'INSERT OR IGNORE INTO bets (player_id, team_id, original_amount, current_amount, bet_type) VALUES (?, ?, ?, ?, ?)'
  );

  withTransaction(() => {
    for (const tid of team_ids) {
      if (bet_type === 'knockout') {
        const team = db.prepare('SELECT advanced_to_knockouts FROM teams WHERE id = ?').get(tid);
        if (!team?.advanced_to_knockouts) {
          errors.push({ team_id: tid, error: 'Ej vidare i turneringen' });
          continue;
        }
      }
      const r = insertOne.run(player_id, tid, amount, amount, bet_type || 'initial');
      if (r.changes > 0) added.push(tid);
      else errors.push({ team_id: tid, error: 'Satsning finns redan' });
    }
  });
  res.json({ added, errors });
});

router.delete('/bets/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM bets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// --- Gruppresultat ---

// Gradvis registrering: markera lag som vidare eller utslagna (kan anropas flera gånger)
router.post('/groups/:group/results', requireAuth, (req, res) => {
  const { group } = req.params;
  const { advanced_team_ids = [], eliminated_team_ids = [] } = req.body;

  const validGroups = 'ABCDEFGHIJKL'.split('');
  if (!validGroups.includes(group.toUpperCase())) {
    return res.status(400).json({ error: 'Ogiltig grupp' });
  }
  if (!Array.isArray(advanced_team_ids) || !Array.isArray(eliminated_team_ids)) {
    return res.status(400).json({ error: 'advanced_team_ids och eliminated_team_ids måste vara arrayer' });
  }
  if (advanced_team_ids.length === 0 && eliminated_team_ids.length === 0) {
    return res.status(400).json({ error: 'Minst ett lag måste bekräftas' });
  }

  try {
    const result = processPartialGroupResults(
      group.toUpperCase(),
      advanced_team_ids.map(Number),
      eliminated_team_ids.map(Number)
    );
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Status: alla grupper med lagstatus och väntande pool
router.get('/groups/status', requireAuth, (req, res) => {
  const groups = 'ABCDEFGHIJKL'.split('').map(g => {
    const teams = db.prepare(
      'SELECT id, name, eliminated, advanced_to_knockouts FROM teams WHERE group_name = ? ORDER BY name'
    ).all(g);

    const pendingKey = `group_${g}_pending`;
    const pendingPool = Number(
      db.prepare('SELECT value FROM settings WHERE key = ?').get(pendingKey)?.value || 0
    );

    const confirmedCount = teams.filter(t => t.eliminated || t.advanced_to_knockouts).length;
    const fullyResolved  = confirmedCount === 4;

    return { group: g, teams, pendingPool, fullyResolved, confirmedCount };
  });

  res.json(groups);
});

// --- Knockout-matcher ---

// Skapa en match (admin registrerar vilka lag som möts)
router.post('/matches', requireAuth, (req, res) => {
  const { team1_id, team2_id, round } = req.body;
  const validRounds = ['r32', 'r16', 'qf', 'sf', 'bronze', 'final'];

  if (!team1_id || !team2_id || !round) return res.status(400).json({ error: 'team1_id, team2_id och round krävs' });
  if (!validRounds.includes(round)) return res.status(400).json({ error: `round måste vara en av: ${validRounds.join(', ')}` });
  if (team1_id === team2_id) return res.status(400).json({ error: 'Lagen måste vara olika' });

  const result = db.prepare(
    'INSERT INTO matches (round, team1_id, team2_id) VALUES (?, ?, ?)'
  ).run(round, team1_id, team2_id);

  res.json({ id: result.lastInsertRowid });
});

// Registrera matchresultat och trigga omfördelning
router.post('/matches/:id/result', requireAuth, (req, res) => {
  const { winner_id } = req.body;
  const matchId = Number(req.params.id);

  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!match) return res.status(404).json({ error: 'Matchen hittades inte' });
  if (match.winner_id) return res.status(400).json({ error: 'Resultatet är redan registrerat' });

  const loserId = match.team1_id === winner_id ? match.team2_id : match.team1_id;

  if (winner_id !== match.team1_id && winner_id !== match.team2_id) {
    return res.status(400).json({ error: 'winner_id måste vara ett av matchens lag' });
  }

  try {
    processKnockoutMatch(matchId, Number(winner_id), loserId, match.round);
    res.json({ ok: true, winner_id, loser_id: loserId, round: match.round });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/matches', requireAuth, (req, res) => {
  const matches = db.prepare(`
    SELECT m.*, t1.name AS team1_name, t2.name AS team2_name, tw.name AS winner_name
    FROM matches m
    JOIN teams t1 ON t1.id = m.team1_id
    JOIN teams t2 ON t2.id = m.team2_id
    LEFT JOIN teams tw ON tw.id = m.winner_id
    ORDER BY m.created_at DESC
  `).all();
  res.json(matches);
});

// Alla lag (för dropdown-val)
router.get('/teams', requireAuth, (req, res) => {
  const teams = db.prepare('SELECT * FROM teams ORDER BY group_name, name').all();
  res.json(teams);
});

// Registreringsstatus
router.get('/registration-status', requireAuth, (req, res) => {
  const get = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value === 'true';
  res.json({
    group_bets_open:    get('group_bets_open'),
    knockout_bets_open: get('knockout_bets_open'),
  });
});

router.post('/registration-status', requireAuth, (req, res) => {
  const { group_bets_open, knockout_bets_open } = req.body;
  if (group_bets_open !== undefined) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('group_bets_open', group_bets_open ? 'true' : 'false');
  }
  if (knockout_bets_open !== undefined) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('knockout_bets_open', knockout_bets_open ? 'true' : 'false');
  }
  res.json({ ok: true });
});

// Nollställ alla turneringsresultat (behåller spelare och satsningar, återställer belopp)
router.post('/reset', requireAuth, (req, res) => {
  withTransaction(() => {
    // Återställ alla satsningsbelopp till original
    db.exec('UPDATE bets SET current_amount = original_amount');
    // Återställ alla lags status
    db.exec('UPDATE teams SET eliminated = 0, advanced_to_knockouts = 0');
    // Ta bort alla matchresultat
    db.exec('DELETE FROM matches');
    // Ta bort alla grupprocessnings-markeringar och väntande pooler
    db.exec("DELETE FROM settings WHERE key LIKE 'group_%_processed'");
    db.exec("DELETE FROM settings WHERE key LIKE 'group_%_pending'");
  });
  res.json({ ok: true, message: 'Alla turneringsresultat nollställda' });
});

module.exports = router;
