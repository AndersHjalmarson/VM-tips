const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'vmpool.db');

const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Hjälpfunktion för transaktioner (node:sqlite saknar inbyggd transaction()-helper)
function withTransaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const TEAMS = [
  { name: 'Mexiko',              group_name: 'A' },
  { name: 'Sydafrika',           group_name: 'A' },
  { name: 'Sydkorea',            group_name: 'A' },
  { name: 'Tjeckien',            group_name: 'A' },
  { name: 'Kanada',              group_name: 'B' },
  { name: 'Bosnien-Hercegovina', group_name: 'B' },
  { name: 'Qatar',               group_name: 'B' },
  { name: 'Schweiz',             group_name: 'B' },
  { name: 'Brasilien',           group_name: 'C' },
  { name: 'Marocko',             group_name: 'C' },
  { name: 'Haiti',               group_name: 'C' },
  { name: 'Skottland',           group_name: 'C' },
  { name: 'USA',                 group_name: 'D' },
  { name: 'Paraguay',            group_name: 'D' },
  { name: 'Australien',          group_name: 'D' },
  { name: 'Turkiet',             group_name: 'D' },
  { name: 'Tyskland',            group_name: 'E' },
  { name: 'Curaçao',             group_name: 'E' },
  { name: 'Elfenbenskusten',     group_name: 'E' },
  { name: 'Ecuador',             group_name: 'E' },
  { name: 'Nederländerna',       group_name: 'F' },
  { name: 'Japan',               group_name: 'F' },
  { name: 'Sverige',             group_name: 'F' },
  { name: 'Tunisien',            group_name: 'F' },
  { name: 'Belgien',             group_name: 'G' },
  { name: 'Egypten',             group_name: 'G' },
  { name: 'Iran',                group_name: 'G' },
  { name: 'Nya Zeeland',         group_name: 'G' },
  { name: 'Spanien',             group_name: 'H' },
  { name: 'Kap Verde',           group_name: 'H' },
  { name: 'Saudiarabien',        group_name: 'H' },
  { name: 'Uruguay',             group_name: 'H' },
  { name: 'Frankrike',           group_name: 'I' },
  { name: 'Senegal',             group_name: 'I' },
  { name: 'Irak',                group_name: 'I' },
  { name: 'Norge',               group_name: 'I' },
  { name: 'Argentina',           group_name: 'J' },
  { name: 'Algeriet',            group_name: 'J' },
  { name: 'Österrike',           group_name: 'J' },
  { name: 'Jordanien',           group_name: 'J' },
  { name: 'Portugal',            group_name: 'K' },
  { name: 'DR Kongo',            group_name: 'K' },
  { name: 'Uzbekistan',          group_name: 'K' },
  { name: 'Colombia',            group_name: 'K' },
  { name: 'England',             group_name: 'L' },
  { name: 'Kroatien',            group_name: 'L' },
  { name: 'Ghana',               group_name: 'L' },
  { name: 'Panama',              group_name: 'L' },
];

function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      group_name TEXT NOT NULL,
      eliminated INTEGER DEFAULT 0,
      advanced_to_knockouts INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      original_amount REAL NOT NULL,
      current_amount REAL NOT NULL,
      bet_type TEXT NOT NULL DEFAULT 'initial',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(player_id, team_id, bet_type)
    );

    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round TEXT NOT NULL,
      team1_id INTEGER REFERENCES teams(id),
      team2_id INTEGER REFERENCES teams(id),
      winner_id INTEGER REFERENCES teams(id),
      played_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const { c } = db.prepare('SELECT COUNT(*) as c FROM teams').get();
  if (c === 0) {
    const insert = db.prepare('INSERT INTO teams (name, group_name) VALUES (?, ?)');
    withTransaction(() => {
      for (const t of TEAMS) insert.run(t.name, t.group_name);
    });
  }

  // Standardvärden för registreringsstatus
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('group_bets_open', 'true');
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('knockout_bets_open', 'true');
}

module.exports = { db, initializeDatabase, withTransaction };
