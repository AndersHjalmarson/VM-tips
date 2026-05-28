const express = require('express');
const router = express.Router();
const { db, withTransaction } = require('../database');

const PARTICIPATION_PASSWORD = 'trafikomlopp';

// Alla lag grupperade med aktuellt satsningsbelopp + väntande pool per grupp
router.get('/groups', (req, res) => {
  const groups = ['A','B','C','D','E','F','G','H','I','J','K','L'];
  const result = {};
  for (const g of groups) {
    const teams = db.prepare(`
      SELECT t.id, t.name, t.group_name, t.eliminated, t.advanced_to_knockouts,
             COALESCE(SUM(b.current_amount), 0) AS current_pot,
             COALESCE(SUM(b.original_amount), 0) AS original_pot,
             COUNT(DISTINCT b.player_id) AS num_bettors
      FROM teams t
      LEFT JOIN bets b ON b.team_id = t.id
      WHERE t.group_name = ?
      GROUP BY t.id
      ORDER BY t.id
    `).all(g);
    const pendingPool = Number(
      db.prepare("SELECT value FROM settings WHERE key = ?").get(`group_${g}_pending`)?.value || 0
    );
    result[g] = { teams, pendingPool };
  }
  res.json(result);
});

// Alla spelare med satsningar och aktuella summor
router.get('/players', (req, res) => {
  const players = db.prepare('SELECT * FROM players ORDER BY name').all();
  const result = players.map(player => {
    const bets = db.prepare(`
      SELECT b.id, b.team_id, t.name AS team_name, t.group_name,
             t.eliminated, t.advanced_to_knockouts,
             b.original_amount, b.current_amount, b.bet_type
      FROM bets b
      JOIN teams t ON t.id = b.team_id
      WHERE b.player_id = ?
      ORDER BY t.group_name, t.name
    `).all(player.id);
    const total = bets.reduce((s, b) => s + b.current_amount, 0);
    const originalTotal = bets.reduce((s, b) => s + b.original_amount, 0);
    return { ...player, bets, total, originalTotal };
  });
  res.json(result);
});

// Slå upp en specifik spelare med namn
router.get('/player/:name', (req, res) => {
  const player = db.prepare('SELECT * FROM players WHERE name = ?').get(req.params.name);
  if (!player) return res.status(404).json({ error: 'Spelare hittades inte' });
  const bets = db.prepare(`
    SELECT b.id, b.team_id, t.name AS team_name, t.group_name,
           t.eliminated, t.advanced_to_knockouts,
           b.original_amount, b.current_amount, b.bet_type
    FROM bets b
    JOIN teams t ON t.id = b.team_id
    WHERE b.player_id = ?
    ORDER BY t.group_name, t.name
  `).all(player.id);
  const total = bets.reduce((s, b) => s + b.current_amount, 0);
  const originalTotal = bets.reduce((s, b) => s + b.original_amount, 0);
  res.json({ player, bets, total, originalTotal });
});

// Sammanfattning
router.get('/summary', (req, res) => {
  const totals = db.prepare(`
    SELECT COALESCE(SUM(current_amount), 0) AS total_pot,
           COALESCE(SUM(original_amount), 0) AS original_pot,
           COUNT(*) AS num_bets,
           COUNT(DISTINCT player_id) AS num_players
    FROM bets
  `).get();
  // Pengar som väntar i grupp-pooler (utslagna men ej fördelade ännu)
  const pendingRow = db.prepare(
    "SELECT COALESCE(SUM(CAST(value AS REAL)), 0) AS total FROM settings WHERE key LIKE 'group_%_pending'"
  ).get();
  const teamsLeft   = db.prepare('SELECT COUNT(*) AS c FROM teams WHERE eliminated = 0').get();
  const lastMatch   = db.prepare('SELECT round FROM matches WHERE winner_id IS NOT NULL ORDER BY played_at DESC LIMIT 1').get();
  const hasAdvanced = db.prepare('SELECT COUNT(*) AS c FROM teams WHERE advanced_to_knockouts = 1').get();
  const groupBetsOpen    = db.prepare("SELECT value FROM settings WHERE key = 'group_bets_open'").get();
  const knockoutBetsOpen = db.prepare("SELECT value FROM settings WHERE key = 'knockout_bets_open'").get();
  const groupBetAmount   = Number(db.prepare("SELECT value FROM settings WHERE key = 'group_bet_amount'").get()?.value || 20);
  const knockoutBetAmount = Number(db.prepare("SELECT value FROM settings WHERE key = 'knockout_bet_amount'").get()?.value || 50);
  res.json({
    ...totals,
    total_pot: totals.total_pot + pendingRow.total, // inkludera väntande pooler
    teams_remaining: teamsLeft.c,
    last_round: lastMatch?.round || null,
    knockout_betting_open: hasAdvanced.c > 0,
    group_bets_open:       groupBetsOpen?.value === 'true',
    knockout_bets_open:    knockoutBetsOpen?.value === 'true',
    group_bet_amount:      groupBetAmount,
    knockout_bet_amount:   knockoutBetAmount,
  });
});

// Knockout-matcher
router.get('/matches', (req, res) => {
  const matches = db.prepare(`
    SELECT m.*, t1.name AS team1_name, t2.name AS team2_name, tw.name AS winner_name
    FROM matches m
    JOIN teams t1 ON t1.id = m.team1_id
    JOIN teams t2 ON t2.id = m.team2_id
    LEFT JOIN teams tw ON tw.id = m.winner_id
    ORDER BY m.created_at
  `).all();
  res.json(matches);
});

// Självregistrering: spelare lägger in egna satsningar
router.post('/register', (req, res) => {
  const { name, team_ids, bet_type, password } = req.body;

  if (password !== PARTICIPATION_PASSWORD) {
    return res.status(403).json({ error: 'Fel lösenord — spelet är bara öppet för anställda på Östgötarafiken.' });
  }

  if (!name?.trim()) return res.status(400).json({ error: 'Namn krävs' });
  if (!Array.isArray(team_ids) || team_ids.length === 0) return res.status(400).json({ error: 'Välj minst ett lag' });

  const type  = bet_type || 'initial';
  const groupAmt   = Number(db.prepare("SELECT value FROM settings WHERE key = 'group_bet_amount'").get()?.value || 20);
  const knockoutAmt = Number(db.prepare("SELECT value FROM settings WHERE key = 'knockout_bet_amount'").get()?.value || 50);
  const amount = type === 'knockout' ? knockoutAmt : groupAmt;

  // Kontrollera om satsningar är öppna
  const settingKey = type === 'knockout' ? 'knockout_bets_open' : 'group_bets_open';
  const setting = db.prepare('SELECT value FROM settings WHERE key = ?').get(settingKey);
  if (setting?.value !== 'true') {
    const label = type === 'knockout' ? 'Slutspelssatsningar' : 'Gruppsatsningar';
    return res.status(403).json({ error: `${label} är stängda — kontakta Anders om du har frågor.` });
  }

  // Hitta eller skapa spelaren
  let player = db.prepare('SELECT * FROM players WHERE name = ?').get(name.trim());
  let isNew = false;
  if (!player) {
    const r = db.prepare('INSERT INTO players (name) VALUES (?)').run(name.trim());
    player = { id: Number(r.lastInsertRowid), name: name.trim() };
    isNew = true;
  }

  const added   = [];
  const skipped = [];

  const insertBet = db.prepare(
    'INSERT OR IGNORE INTO bets (player_id, team_id, original_amount, current_amount, bet_type) VALUES (?, ?, ?, ?, ?)'
  );

  withTransaction(() => {
    for (const tid of team_ids.map(Number)) {
      if (type === 'knockout') {
        const team = db.prepare('SELECT advanced_to_knockouts FROM teams WHERE id = ?').get(tid);
        if (!team?.advanced_to_knockouts) { skipped.push(tid); continue; }
      }
      const r = insertBet.run(player.id, tid, amount, amount, type);
      if (r.changes > 0) added.push(tid);
      else skipped.push(tid);
    }
  });

  const amountDue = added.length * amount;

  res.json({
    player,
    isNew,
    added,
    skipped,
    amountDue,
    swish: amountDue > 0 ? {
      recipient: 'Anders Hjalmarson',
      number: '0708-883225',
      amount: amountDue,
      message: `VM-tipset 2026 - ${name.trim()}`,
    } : null,
  });
});

module.exports = router;
