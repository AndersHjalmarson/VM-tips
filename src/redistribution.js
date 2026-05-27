const { db, withTransaction } = require('./database');

// ── Gruppspel ─────────────────────────────────────────────────────────────────
//
// Stöder GRADVIS registrering: admin kan markera lag ett i taget.
// Utslagna lags pengar läggs i en grupp-pool och fördelas INTE direkt — de
// väntar tills alla fyra lag i gruppen har en säker status (vidare / utslaget).
// Då fördelas hela poolen jämnt per spelare på de vidare-lagen.
//
// Kan anropas flera gånger med kumulativa listor.
//
function processPartialGroupResults(groupName, confirmedAdvancedIds, confirmedEliminatedIds) {
  const allGroupTeams = db.prepare('SELECT * FROM teams WHERE group_name = ?').all(groupName);

  // Vilka är NYLIGEN bekräftade (inte redan markerade i DB)?
  const newlyEliminated = allGroupTeams.filter(t =>
    confirmedEliminatedIds.includes(t.id) && !t.eliminated
  );
  const newlyAdvanced = allGroupTeams.filter(t =>
    confirmedAdvancedIds.includes(t.id) && !t.advanced_to_knockouts
  );

  // Alla bekräftade efter denna körning (DB + nya)
  const allEliminatedIds = [
    ...allGroupTeams.filter(t => t.eliminated).map(t => t.id),
    ...newlyEliminated.map(t => t.id),
  ];
  const allAdvancedIds = [
    ...allGroupTeams.filter(t => t.advanced_to_knockouts).map(t => t.id),
    ...newlyAdvanced.map(t => t.id),
  ];

  const ph = arr => arr.map(() => '?').join(',');

  // Hämta satsningar på nyligen utslagna lag
  const newlyEliminatedBets = newlyEliminated.length > 0
    ? db.prepare(`SELECT * FROM bets WHERE team_id IN (${ph(newlyEliminated.map(t => t.id))}) AND current_amount > 0`)
        .all(...newlyEliminated.map(t => t.id))
    : [];

  const newlyEliminatedAmount = newlyEliminatedBets.reduce((s, b) => s + b.current_amount, 0);

  // Hämta nuvarande grupp-pool
  const pendingKey = `group_${groupName}_pending`;
  const currentPending = Number(db.prepare('SELECT value FROM settings WHERE key = ?').get(pendingKey)?.value || 0);
  const newPending = currentPending + newlyEliminatedAmount;

  // Är gruppen nu helt klar? (inga lag med oklart status kvar)
  const uncertainTeams = allGroupTeams.filter(t =>
    !allEliminatedIds.includes(t.id) && !allAdvancedIds.includes(t.id)
  );
  const fullyResolved = uncertainTeams.length === 0;

  withTransaction(() => {
    // Nollställ nyligen utslagna lags satsningar
    for (const bet of newlyEliminatedBets) {
      db.prepare('UPDATE bets SET current_amount = 0 WHERE id = ?').run(bet.id);
    }

    // Uppdatera lagstatus
    for (const team of newlyEliminated) {
      db.prepare('UPDATE teams SET eliminated = 1 WHERE id = ?').run(team.id);
    }
    for (const team of newlyAdvanced) {
      db.prepare('UPDATE teams SET advanced_to_knockouts = 1 WHERE id = ?').run(team.id);
    }

    if (fullyResolved && newPending > 0) {
      // Alla lag klara → fördela hela pool-beloppet till vidare-lagen
      const advancingBets = allAdvancedIds.length > 0
        ? db.prepare(`SELECT * FROM bets WHERE team_id IN (${ph(allAdvancedIds)})`).all(...allAdvancedIds)
        : [];

      // Jämn fördelning per spelare
      const byPlayer = {};
      for (const bet of advancingBets) {
        if (!byPlayer[bet.player_id]) byPlayer[bet.player_id] = [];
        byPlayer[bet.player_id].push(bet);
      }
      const uniquePlayers = Object.keys(byPlayer);

      if (uniquePlayers.length > 0) {
        const perPlayer = newPending / uniquePlayers.length;
        for (const pid of uniquePlayers) {
          const pBets = byPlayer[pid];
          const perBet = perPlayer / pBets.length;
          for (const bet of pBets) {
            db.prepare('UPDATE bets SET current_amount = current_amount + ? WHERE id = ?').run(perBet, bet.id);
          }
        }
      }

      // Rensa grupp-poolen
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(pendingKey, '0');
    } else {
      // Uppdatera grupp-poolen med nya utslagna pengar
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(pendingKey, String(newPending));
    }
  });

  return {
    group: groupName,
    newlyEliminated: newlyEliminated.length,
    newlyAdvanced: newlyAdvanced.length,
    pendingPool: fullyResolved ? 0 : newPending,
    totalDistributed: fullyResolved ? newPending : 0,
    fullyResolved,
    uncertainTeams: uncertainTeams.length,
    allAdvancedIds,
    allEliminatedIds,
  };
}

// ── Knockout ──────────────────────────────────────────────────────────────────

function processKnockoutMatch(matchId, winnerId, loserId, round) {
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!match) throw new Error('Matchen hittades inte');
  if (match.winner_id) throw new Error('Matchresultatet är redan registrerat');

  withTransaction(() => {
    if (round === 'final')       _processFinal(winnerId, loserId);
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
  const totalShares   = winnerPlayers.length * 2 + loserPlayers.length;
  const shareValue    = totalPool / (totalShares || 1);

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

module.exports = { processPartialGroupResults, processKnockoutMatch };
