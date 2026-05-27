const { db, withTransaction } = require('./database');

function processGroupResults(groupName, advancedTeamIds) {
  const settingKey = `group_${groupName}_processed`;
  const alreadyDone = db.prepare('SELECT value FROM settings WHERE key = ?').get(settingKey);
  if (alreadyDone) throw new Error(`Grupp ${groupName} är redan behandlad`);

  const allTeams = db.prepare('SELECT id FROM teams WHERE group_name = ?').all(groupName);
  const eliminatedIds = allTeams.map(t => t.id).filter(id => !advancedTeamIds.includes(id));

  const ph = (arr) => arr.map(() => '?').join(',');

  const eliminatedBets = eliminatedIds.length > 0
    ? db.prepare(`SELECT * FROM bets WHERE team_id IN (${ph(eliminatedIds)}) AND current_amount > 0`).all(...eliminatedIds)
    : [];

  const totalPool = eliminatedBets.reduce((s, b) => s + b.current_amount, 0);

  const advancingBets = advancedTeamIds.length > 0
    ? db.prepare(`SELECT * FROM bets WHERE team_id IN (${ph(advancedTeamIds)})`).all(...advancedTeamIds)
    : [];

  // Gruppera vidare-satsningar per spelare (jämn fördelning per spelare, inte per satsning)
  const byPlayer = {};
  for (const bet of advancingBets) {
    if (!byPlayer[bet.player_id]) byPlayer[bet.player_id] = [];
    byPlayer[bet.player_id].push(bet);
  }
  const uniquePlayers = Object.keys(byPlayer);

  withTransaction(() => {
    if (totalPool > 0 && uniquePlayers.length > 0) {
      const perPlayer = totalPool / uniquePlayers.length;
      for (const pid of uniquePlayers) {
        const pBets = byPlayer[pid];
        const perBet = perPlayer / pBets.length;
        for (const bet of pBets) {
          db.prepare('UPDATE bets SET current_amount = current_amount + ? WHERE id = ?').run(perBet, bet.id);
        }
      }
    }
    for (const bet of eliminatedBets) {
      db.prepare('UPDATE bets SET current_amount = 0 WHERE id = ?').run(bet.id);
    }
    for (const id of advancedTeamIds) {
      db.prepare('UPDATE teams SET advanced_to_knockouts = 1 WHERE id = ?').run(id);
    }
    for (const id of eliminatedIds) {
      db.prepare('UPDATE teams SET eliminated = 1 WHERE id = ?').run(id);
    }
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(settingKey, 'true');
  });

  return {
    group: groupName,
    totalRedistributed: totalPool,
    toPlayers: uniquePlayers.length,
    advancedTeams: advancedTeamIds.length,
    eliminatedTeams: eliminatedIds.length,
  };
}

function processKnockoutMatch(matchId, winnerId, loserId, round) {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!match) throw new Error('Matchen hittades inte');
  if (match.winner_id) throw new Error('Matchresultatet är redan registrerat');

  withTransaction(() => {
    if (round === 'final')  _processFinal(winnerId, loserId);
    else if (round === 'bronze') _processBronze(winnerId, loserId);
    else if (round === 'sf')     _processSemifinal(winnerId, loserId);
    else                         _processRegularKnockout(winnerId, loserId);

    db.prepare('UPDATE matches SET winner_id = ?, played_at = CURRENT_TIMESTAMP WHERE id = ?').run(winnerId, matchId);
  });
}

function _processRegularKnockout(winnerId, loserId) {
  const loserBets  = db.prepare('SELECT * FROM bets WHERE team_id = ? AND current_amount > 0').all(loserId);
  const winnerBets = db.prepare('SELECT * FROM bets WHERE team_id = ? AND current_amount > 0').all(winnerId);
  const loserPool  = loserBets.reduce((s, b) => s + b.current_amount, 0);
  const winnerTotal = winnerBets.reduce((s, b) => s + b.current_amount, 0);

  if (loserPool > 0 && winnerTotal > 0) {
    for (const bet of winnerBets) {
      const share = loserPool * (bet.current_amount / winnerTotal);
      db.prepare('UPDATE bets SET current_amount = current_amount + ? WHERE id = ?').run(share, bet.id);
    }
  }
  for (const bet of loserBets) {
    db.prepare('UPDATE bets SET current_amount = 0 WHERE id = ?').run(bet.id);
  }
  db.prepare('UPDATE teams SET eliminated = 1 WHERE id = ?').run(loserId);
}

function _processSemifinal(winnerId, loserId) {
  const loserBets  = db.prepare('SELECT * FROM bets WHERE team_id = ? AND current_amount > 0').all(loserId);
  const winnerBets = db.prepare('SELECT * FROM bets WHERE team_id = ? AND current_amount > 0').all(winnerId);
  const loserPool  = loserBets.reduce((s, b) => s + b.current_amount, 0);
  const winnerTotal = winnerBets.reduce((s, b) => s + b.current_amount, 0);

  const toWinner = loserPool * 0.75;
  if (toWinner > 0 && winnerTotal > 0) {
    for (const bet of winnerBets) {
      const share = toWinner * (bet.current_amount / winnerTotal);
      db.prepare('UPDATE bets SET current_amount = current_amount + ? WHERE id = ?').run(share, bet.id);
    }
  }
  // 25% stannar kvar på förlorarens satsningar — pengarna följer med till bronsmatchen
  for (const bet of loserBets) {
    db.prepare('UPDATE bets SET current_amount = current_amount * 0.25 WHERE id = ?').run(bet.id);
  }
}

function _processBronze(winnerId, loserId) {
  const allBets    = db.prepare('SELECT * FROM bets WHERE team_id IN (?, ?) AND current_amount > 0').all(winnerId, loserId);
  const winnerBets = allBets.filter(b => b.team_id === winnerId);
  const loserBets  = allBets.filter(b => b.team_id === loserId);
  const totalPool  = allBets.reduce((s, b) => s + b.current_amount, 0);
  const winnerTotal = winnerBets.reduce((s, b) => s + b.current_amount, 0);

  if (totalPool > 0 && winnerTotal > 0) {
    for (const bet of winnerBets) {
      db.prepare('UPDATE bets SET current_amount = ? WHERE id = ?').run(
        totalPool * (bet.current_amount / winnerTotal), bet.id
      );
    }
  }
  for (const bet of loserBets) {
    db.prepare('UPDATE bets SET current_amount = 0 WHERE id = ?').run(bet.id);
  }
  db.prepare('UPDATE teams SET eliminated = 1 WHERE id = ?').run(loserId);
}

function _processFinal(winnerId, loserId) {
  const allBets   = db.prepare('SELECT * FROM bets WHERE team_id IN (?, ?) AND current_amount > 0').all(winnerId, loserId);
  const totalPool = allBets.reduce((s, b) => s + b.current_amount, 0);

  const winnerByPlayer = {};
  const loserByPlayer  = {};
  for (const bet of allBets) {
    const bucket = bet.team_id === winnerId ? winnerByPlayer : loserByPlayer;
    if (!bucket[bet.player_id]) bucket[bet.player_id] = [];
    bucket[bet.player_id].push(bet);
  }

  const winnerPlayers = Object.keys(winnerByPlayer);
  const loserPlayers  = Object.keys(loserByPlayer);
  // Vinnarsatsning = 2 andelar per spelare, förlorarsatsning = 1 andel
  const totalShares = winnerPlayers.length * 2 + loserPlayers.length;
  const shareValue  = totalPool / (totalShares || 1);

  for (const pid of winnerPlayers) {
    const bets = winnerByPlayer[pid];
    const perBet = (shareValue * 2) / bets.length;
    for (const bet of bets) {
      db.prepare('UPDATE bets SET current_amount = ? WHERE id = ?').run(perBet, bet.id);
    }
  }
  for (const pid of loserPlayers) {
    const bets = loserByPlayer[pid];
    const perBet = shareValue / bets.length;
    for (const bet of bets) {
      db.prepare('UPDATE bets SET current_amount = ? WHERE id = ?').run(perBet, bet.id);
    }
  }
}

module.exports = { processGroupResults, processKnockoutMatch };
