const ROUND_LABELS = {
  r32: 'Sextondelsfinaler', r16: 'Åttondelsfinaler',
  qf: 'Kvartsfinaler', sf: 'Semifinaler',
  bronze: 'Bronsmatch', final: 'Final',
};

let groupsData = {};
let playersData = [];
let allTeams = [];       // platt lista för registreringsformuläret
let currentBetType = 'initial';
let existingBetTeamIds = new Set(); // lag spelaren redan satsat på
let lastSummary = null;  // cache för att kunna uppdatera knappstate vid typbyte
let leaderboardView = 'players'; // 'players' | 'teams'

// ── Tabs ──────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => showTab(btn.dataset.tab));
});

function showTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
}

// ── Hjälpfunktioner ───────────────────────────────

function fmt(n) {
  return (n || 0).toFixed(2).replace('.', ',') + ' kr';
}

function showRegAlert(msg, type = 'error') {
  const el = document.getElementById('reg-alert');
  el.innerHTML = `<div class="alert alert-${type}" style="margin-top:12px">${msg}</div>`;
  if (type === 'success') setTimeout(() => { el.innerHTML = ''; }, 5000);
}

// ── Data-hämtning ─────────────────────────────────

async function fetchAll() {
  try {
    const [summary, groups, players, matches] = await Promise.all([
      fetch('/api/summary').then(r => r.json()),
      fetch('/api/groups').then(r => r.json()),
      fetch('/api/players').then(r => r.json()),
      fetch('/api/matches').then(r => r.json()),
    ]);

    groupsData = groups;
    playersData = players;

    // Bygg platt lag-lista (stöder både gammalt array-format och nytt {teams, pendingPool})
    allTeams = Object.values(groups).flatMap(g => Array.isArray(g) ? g : (g.teams || []));

    lastSummary = summary;
    renderStats(summary);
    renderGroups(groups);
    renderPlayers(players);
    renderLeaderboard(players);
    renderTeamLeaderboard();
    renderMatches(matches);
    updateAmountDisplays();    // uppdatera beloppsvisningar (kr-etiketter)
    updateTeamGrid();          // uppdatera registreringsformuläret med aktuella potter

    // Visa/dölj slutspelssatsning-knappen
    const knockoutBtn = document.getElementById('knockout-btn');
    if (knockoutBtn) {
      knockoutBtn.style.display = summary.knockout_betting_open ? '' : 'none';
      document.getElementById('reg-type-toggle').style.display = summary.knockout_betting_open ? '' : 'none';
    }

    // Visa stängningsmeddelanden i formuläret
    renderRegClosedBanners(summary);

    document.getElementById('last-refresh').textContent = new Date().toLocaleTimeString('sv-SE');
  } catch (e) {
    console.error('Hämtningsfel:', e);
  }
}

// ── Beloppsvisningar ──────────────────────────────
// Uppdaterar alla element med data-amount-key-attribut från lastSummary

function updateAmountDisplays() {
  if (!lastSummary) return;
  const map = {
    group_bet_amount:   lastSummary.group_bet_amount   || 20,
    knockout_bet_amount: lastSummary.knockout_bet_amount || 50,
  };
  document.querySelectorAll('[data-amount-key]').forEach(el => {
    const val = map[el.dataset.amountKey];
    if (val === undefined) return;
    const fmt = el.dataset.format || '';
    el.textContent = fmt ? `${val} ${fmt}` : String(val);
  });
}

// ── Vy: Statistikrad ──────────────────────────────

function renderStats(s) {
  document.getElementById('stat-total').textContent   = fmt(s.total_pot);
  document.getElementById('stat-players').textContent = s.num_players || 0;
  document.getElementById('stat-bets').textContent    = s.num_bets || 0;
  document.getElementById('stat-teams').textContent   = s.teams_remaining || 0;
}

// ── Vy: Grupper ───────────────────────────────────

function renderGroups(groups) {
  const container = document.getElementById('groups-container');
  container.innerHTML = '';

  for (const letter of 'ABCDEFGHIJKL'.split('')) {
    const rawGroup = groups[letter];
    if (!rawGroup) continue;

    // Stöder både gammalt array-format och nytt {teams, pendingPool}
    const teams      = Array.isArray(rawGroup) ? rawGroup : (rawGroup.teams || []);
    const pendingPool = Array.isArray(rawGroup) ? 0 : (rawGroup.pendingPool || 0);
    if (!teams.length) continue;

    const activePot  = teams.reduce((s, t) => s + (t.current_pot || 0), 0);
    const totalPot   = activePot + pendingPool;
    const processed  = teams.every(t => t.eliminated || t.advanced_to_knockouts);

    // Visa väntande pool separat i rubriken om det finns
    let potLine;
    if (pendingPool > 0) {
      potLine = `${fmt(activePot)} aktiva satsningar · <span style="color:var(--accent)">+${fmt(pendingPool)} väntande pool</span>`;
    } else {
      potLine = `${fmt(totalPot)} i pott${processed ? ' · Avslutad' : ''}`;
    }

    const card = document.createElement('div');
    card.className = 'group-card';
    card.innerHTML = `
      <div class="group-header">
        <div class="group-letter">${letter}</div>
        <div class="group-header-info">
          <h3>Grupp ${letter}</h3>
          <p>${potLine}</p>
        </div>
      </div>
      ${teams.map(t => {
        const statusHtml = t.eliminated
          ? '<span class="team-status status-eliminated">Utslaget</span>'
          : t.advanced_to_knockouts
            ? '<span class="team-status status-advanced">Vidare ✓</span>'
            : '<span class="team-status status-active">Aktiv</span>';
        return `
          <div class="team-row${t.eliminated ? ' eliminated' : ''}">
            <span class="team-name">${t.name}</span>
            ${statusHtml}
            <span class="team-bettors" title="${t.num_bettors} satsare">👤${t.num_bettors}</span>
            <span class="team-pot${t.current_pot === 0 ? ' zero' : ''}" title="Aktuell pott">${fmt(t.current_pot)}</span>
          </div>`;
      }).join('')}
    `;
    container.appendChild(card);
  }
}

// ── Vy: Per spelare ───────────────────────────────

function renderPlayers(players) {
  const container = document.getElementById('players-container');
  container.innerHTML = players.map(p => {
    const betRows = p.bets.map(b => {
      const diff = b.current_amount - b.original_amount;
      const diffHtml = Math.abs(diff) > 0.009
        ? `<span style="font-size:11px;font-weight:700;color:${diff > 0 ? 'var(--green)' : 'var(--red)'};
                        min-width:52px;text-align:right;white-space:nowrap">
             ${diff > 0 ? '+' : ''}${fmt(diff)}
           </span>`
        : `<span style="min-width:52px"></span>`;

      const statusBadge = b.eliminated
        ? `<span style="font-size:10px;background:#450a0a;color:#fca5a5;
                        padding:1px 5px;border-radius:3px;margin-left:4px;white-space:nowrap">
             Utslaget
           </span>`
        : b.advanced_to_knockouts
          ? `<span style="font-size:10px;background:#064e3b;color:#6ee7b7;
                          padding:1px 5px;border-radius:3px;margin-left:4px;white-space:nowrap">
               Vidare ✓
             </span>`
          : '';

      return `
        <div class="player-bet-row${b.eliminated ? ' eliminated' : ''}">
          <span class="bet-team">
            ${b.team_name}${statusBadge}<span class="bet-group"> Gr.${b.group_name}</span>
          </span>
          <span class="bet-type-badge ${b.bet_type === 'knockout' ? 'bet-knockout' : 'bet-initial'}">
            ${b.bet_type === 'knockout' ? 'Slutspel' : 'Grupp'}
          </span>
          <span class="bet-orig" title="Ursprunglig satsning">${fmt(b.original_amount)}</span>
          <span class="bet-curr" title="Aktuellt saldo">${fmt(b.current_amount)}</span>
          ${diffHtml}
        </div>`;
    }).join('');

    const totalDiff = p.total - p.originalTotal;
    const totalDiffHtml = Math.abs(totalDiff) > 0.009
      ? `<span style="font-size:12px;color:${totalDiff >= 0 ? 'var(--green)' : 'var(--red)'}">
           ${totalDiff >= 0 ? '+' : ''}${fmt(totalDiff)}
         </span>`
      : '';

    return `
      <div class="player-card">
        <div class="player-header">
          <span class="player-name">${p.name}</span>
          <div style="text-align:right">
            <div class="player-total" title="Aktuellt totalsaldo">${fmt(p.total)}</div>
            ${totalDiffHtml}
          </div>
        </div>
        ${betRows || '<div style="padding:12px 16px;color:var(--text3)">Inga satsningar</div>'}
      </div>`;
  }).join('');
}

// ── Vy: Topplista ─────────────────────────────────

function renderLeaderboard(players) {
  const sorted = [...players].sort((a, b) => b.total - a.total);
  const medals = ['🥇', '🥈', '🥉'];
  document.getElementById('leaderboard-container').innerHTML = sorted.map((p, i) => {
    const teams = p.bets.filter(b => !b.eliminated && b.current_amount > 0).map(b => b.team_name).join(', ');
    const diff  = p.total - p.originalTotal;
    const diffHtml = Math.abs(diff) > 0.009
      ? `<div style="font-size:11px;color:${diff >= 0 ? 'var(--green)' : 'var(--red)'}">
           ${diff >= 0 ? '+' : ''}${fmt(diff)} vs. insats
         </div>`
      : '';
    return `
      <div class="lb-row">
        <div class="lb-rank${i < 3 ? ' top' + (i+1) : ''}">${i < 3 ? medals[i] : '#' + (i+1)}</div>
        <div style="flex:1;min-width:0">
          <div class="lb-name">${p.name}</div>
          <div class="lb-teams">${teams || 'Alla lag utslagna'}</div>
          ${diffHtml}
        </div>
        <div class="lb-amount">${fmt(p.total)}</div>
      </div>`;
  }).join('');
}

// ── Vy: Topplista-toggle ──────────────────────────

function setLeaderboardView(view) {
  leaderboardView = view;
  document.getElementById('lb-btn-players').classList.toggle('active', view === 'players');
  document.getElementById('lb-btn-teams').classList.toggle('active', view === 'teams');
  document.getElementById('leaderboard-container').style.display        = view === 'players' ? '' : 'none';
  document.getElementById('leaderboard-teams-container').style.display  = view === 'teams'   ? '' : 'none';
}

// ── Vy: Topplista per lag ─────────────────────────

function renderTeamLeaderboard() {
  const container = document.getElementById('leaderboard-teams-container');
  if (!container) return;

  // Dela upp i aktiva (inkl. vidare) och utslagna
  const active    = [...allTeams].filter(t => !t.eliminated).sort((a, b) => b.current_pot - a.current_pot);
  const eliminated = [...allTeams].filter(t => t.eliminated).sort((a, b) => b.original_pot - a.original_pot);

  const medals = ['🥇', '🥈', '🥉'];

  const activeRows = active.map((t, i) => {
    const diff = t.current_pot - t.original_pot;
    const diffHtml = Math.abs(diff) > 0.009
      ? `<div style="font-size:11px;color:${diff >= 0 ? 'var(--green)' : 'var(--red)'}">
           ${diff >= 0 ? '+' : ''}${fmt(diff)} vs. insats
         </div>`
      : '';
    const statusBadge = t.advanced_to_knockouts
      ? '<span class="team-status status-advanced" style="font-size:10px;margin-left:0">Vidare ✓</span>'
      : '<span class="team-status status-active" style="font-size:10px;margin-left:0">Aktiv</span>';
    return `
      <div class="lb-row">
        <div class="lb-rank${i < 3 ? ' top'+(i+1) : ''}">${i < 3 ? medals[i] : '#'+(i+1)}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span class="lb-name">${t.name}</span>
            <span style="font-size:11px;color:var(--text3);background:var(--bg2);padding:1px 6px;border-radius:4px;font-weight:700">Gr.${t.group_name}</span>
            ${statusBadge}
          </div>
          <div style="font-size:12px;color:var(--text3);margin-top:2px">👤 ${t.num_bettors} satsare · ${fmt(t.original_pot)} i insats</div>
          ${diffHtml}
        </div>
        <div class="lb-amount">${fmt(t.current_pot)}</div>
      </div>`;
  }).join('');

  let eliminatedSection = '';
  if (eliminated.length) {
    const elimRows = eliminated.map(t => `
      <div class="lb-row" style="opacity:0.45">
        <div class="lb-rank" style="font-size:16px">💀</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span style="font-size:15px;font-weight:600;text-decoration:line-through;color:var(--text2)">${t.name}</span>
            <span style="font-size:11px;color:var(--text3);background:var(--bg2);padding:1px 6px;border-radius:4px;font-weight:700">Gr.${t.group_name}</span>
            <span class="team-status status-eliminated" style="font-size:10px;margin-left:0">Utslaget</span>
          </div>
          <div style="font-size:12px;color:var(--text3);margin-top:2px">👤 ${t.num_bettors} satsare · ${fmt(t.original_pot)} i insats</div>
        </div>
        <div style="font-size:16px;font-weight:700;color:var(--text3)">${fmt(t.current_pot)}</div>
      </div>`).join('');
    eliminatedSection = `
      <details style="margin-top:16px">
        <summary style="font-size:13px;color:var(--text3);cursor:pointer;padding:8px 4px;font-weight:600;user-select:none">
          Utslagna lag (${eliminated.length}) — klicka för att visa
        </summary>
        <div style="margin-top:8px">${elimRows}</div>
      </details>`;
  }

  if (!active.length && !eliminated.length) {
    container.innerHTML = '<p style="color:var(--text3)">Inga lag ännu.</p>';
    return;
  }

  container.innerHTML = `<div style="max-width:700px">${activeRows || '<p style="color:var(--text3);margin-bottom:12px">Inga aktiva lag.</p>'}${eliminatedSection}</div>`;
}

// ── Vy: Matcher ───────────────────────────────────

function renderMatches(matches) {
  const container = document.getElementById('matches-container');
  if (!matches.length) {
    container.innerHTML = '<p style="color:var(--text3)">Inga slutspelsmatcher registrerade ännu.</p>';
    return;
  }
  const byRound = {};
  for (const m of matches) {
    (byRound[m.round] = byRound[m.round] || []).push(m);
  }
  let html = '';
  for (const round of ['r32','r16','qf','sf','bronze','final']) {
    if (!byRound[round]) continue;
    html += `<h3 class="round-label" style="margin:16px 0 10px">${ROUND_LABELS[round]}</h3><div style="display:grid;gap:8px">`;
    for (const m of byRound[round]) {
      const w = m.winner_id;
      const t1s = w ? (w === m.team1_id ? 'color:var(--green);font-weight:700' : 'color:var(--text3);text-decoration:line-through') : '';
      const t2s = w ? (w === m.team2_id ? 'color:var(--green);font-weight:700' : 'color:var(--text3);text-decoration:line-through') : '';
      html += `
        <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px 16px;display:flex;align-items:center;gap:12px">
          <span style="${t1s};flex:1">${m.team1_name}</span>
          <span style="color:var(--text3);font-weight:700">vs</span>
          <span style="${t2s};flex:1;text-align:right">${m.team2_name}</span>
          ${w ? `<span style="color:var(--text3);font-size:11px;white-space:nowrap">✓ ${m.winner_name}</span>` : '<span style="color:var(--accent);font-size:11px">Ej spelad</span>'}
        </div>`;
    }
    html += '</div>';
  }
  container.innerHTML = html;
}

// ── Stängningsbanners ─────────────────────────────

function renderRegClosedBanners(summary) {
  const existing = document.getElementById('reg-closed-banner');
  if (existing) existing.remove();

  const isInitial = currentBetType === 'initial';
  const isClosed  = isInitial ? !summary.group_bets_open : !summary.knockout_bets_open;

  // Sätt alltid knappens state — annars aktiveras aldrig knappen om den
  // tidigare inaktiverats (t.ex. när gruppsatsningar var stängda och
  // användaren byter till öppna slutspelssatsningar).
  const submitBtn = document.querySelector('#reg-form-section .btn-primary');
  if (submitBtn) submitBtn.disabled = isClosed;

  if (!isClosed) return;

  const label = isInitial ? 'Gruppsatsningar' : 'Slutspelssatsningar';
  const banner = document.createElement('div');
  banner.id = 'reg-closed-banner';
  banner.className = 'alert alert-error';
  banner.style.cssText = 'margin-bottom:12px';
  banner.innerHTML = `🔒 <strong>${label} är stängda.</strong> Det går inte längre att anmäla sig. Kontakta Anders om du har frågor.`;

  const formSection = document.getElementById('reg-form-section');
  formSection.insertBefore(banner, formSection.firstChild);
}

// ── Registreringsformulär ─────────────────────────

function setBetType(type) {
  currentBetType = type;
  document.querySelectorAll('.bet-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  existingBetTeamIds = new Set(); // rensa vid typbyte
  updateTeamGrid();
  // Uppdatera knappens disabled-state direkt (inte vänta på nästa 30s-poll)
  if (lastSummary) renderRegClosedBanners(lastSummary);
}

function updateTeamGrid() {
  const container = document.getElementById('reg-teams-grid');
  if (!container || !allTeams.length) return;

  // Spara vilka lag som är ikryssade just nu — så de återställs efter omritning
  const checkedIds = new Set(
    [...document.querySelectorAll('.reg-team-cb:checked:not(:disabled)')].map(c => Number(c.value))
  );

  const isKnockout = currentBetType === 'knockout';
  const visibleTeams = isKnockout
    ? allTeams.filter(t => t.advanced_to_knockouts && !t.eliminated)
    : allTeams.filter(t => !t.eliminated);

  if (!visibleTeams.length) {
    container.innerHTML = `<p style="color:var(--text3);padding:8px">${isKnockout ? 'Inga slutspelslag tillgängliga ännu.' : 'Inga tillgängliga lag.'}</p>`;
    return;
  }

  const byGroup = {};
  for (const t of visibleTeams) {
    (byGroup[t.group_name] = byGroup[t.group_name] || []).push(t);
  }

  container.innerHTML = Object.entries(byGroup)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([g, teams]) => `
      <div class="reg-group-header">Grupp ${g}</div>
      ${teams.map(t => {
        const alreadyBet = existingBetTeamIds.has(t.id);
        const advBadge = t.advanced_to_knockouts && !isKnockout
          ? '<span style="font-size:10px;background:#064e3b;color:#6ee7b7;padding:1px 5px;border-radius:3px;flex-shrink:0">✓ Vidare</span>'
          : '';
        return `
          <label class="reg-team-row${alreadyBet ? ' already-bet' : ''}">
            <input type="checkbox" class="reg-team-cb" value="${t.id}"
              ${alreadyBet ? 'disabled checked' : ''}
              onchange="updateTotal()">
            <span class="reg-team-name">${t.name}</span>
            ${advBadge}
            ${alreadyBet
              ? '<span class="already-label">Redan satsat</span>'
              : `<span class="reg-team-pot" style="color:var(--accent);font-weight:700;font-size:12px">${fmt(t.current_pot)}</span>`}
          </label>`;
      }).join('')}
    `).join('');

  // Återställ ikryssade lag efter omritning
  document.querySelectorAll('.reg-team-cb:not(:disabled)').forEach(cb => {
    if (checkedIds.has(Number(cb.value))) cb.checked = true;
  });

  updateTotal();
}

function updateTotal() {
  const checked = document.querySelectorAll('.reg-team-cb:checked:not(:disabled)');
  const amount = currentBetType === 'knockout'
    ? (lastSummary?.knockout_bet_amount || 50)
    : (lastSummary?.group_bet_amount    || 20);
  document.getElementById('reg-count').textContent = checked.length;
  document.getElementById('reg-total').textContent = fmt(checked.length * amount);
}

function clearRegResult() {
  existingBetTeamIds = new Set();
  document.getElementById('reg-alert').innerHTML = '';
  updateTeamGrid();
}

async function submitRegistration() {
  const name = document.getElementById('reg-name').value.trim();
  if (!name) return showRegAlert('Ange ditt namn.');

  const password = document.getElementById('reg-password').value;
  if (!password) return showRegAlert('Ange lösenordet.');

  const checkedBoxes = document.querySelectorAll('.reg-team-cb:checked:not(:disabled)');
  const teamIds = [...checkedBoxes].map(c => Number(c.value));
  if (!teamIds.length) return showRegAlert('Välj minst ett lag.');

  try {
    const r = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, team_ids: teamIds, bet_type: currentBetType, password }),
    });
    const data = await r.json();
    if (!r.ok) return showRegAlert(data.error || 'Okänt fel.');

    showSwishConfirmation(data, name, teamIds);
    fetchAll(); // uppdatera live-datan
  } catch (e) {
    showRegAlert('Nätverksfel — försök igen.');
  }
}

function showSwishConfirmation(data, name, teamIds) {
  document.getElementById('reg-form-section').style.display = 'none';
  const conf = document.getElementById('swish-confirmation');
  conf.style.display = '';

  // Vilka lag registrerades
  const addedTeams = allTeams.filter(t => data.added.includes(t.id)).map(t => t.name);
  const skippedCount = data.skipped.length;

  if (data.amountDue > 0) {
    let teamsText = `Du satsade på: ${addedTeams.join(', ')}.`;
    if (skippedCount) teamsText += ` (${skippedCount} lag ignorerade — redan registrerade.)`;
    document.getElementById('swish-teams-text').textContent = teamsText;
    document.getElementById('swish-amount-display').textContent = fmt(data.amountDue);
    document.getElementById('swish-msg').textContent = data.swish.message;
    document.getElementById('swish-extra-msg').textContent = '';
  } else {
    // Inga nya satsningar — allt redan registrerat
    document.getElementById('swish-teams-text').textContent =
      `Hej ${name}! Du hade redan registrerat dessa lag.`;
    document.getElementById('swish-amount-display').textContent = '0 kr';
    document.getElementById('swish-extra-msg').textContent =
      'Inget nytt att betala — du är redan registrerad för dessa lag.';
    document.getElementById('swish-msg').textContent = '';
  }
}

function copyNumber() {
  navigator.clipboard.writeText('0708883225').then(() => {
    const el = document.getElementById('swish-number-text');
    const orig = el.textContent;
    el.textContent = 'Kopierat!';
    setTimeout(() => { el.textContent = orig; }, 2000);
  });
}

function resetRegistration() {
  document.getElementById('reg-form-section').style.display = '';
  document.getElementById('swish-confirmation').style.display = 'none';
  document.getElementById('reg-name').value = '';
  document.getElementById('reg-password').value = '';
  document.getElementById('reg-alert').innerHTML = '';
  existingBetTeamIds = new Set();
  document.querySelectorAll('.reg-team-cb:not(:disabled)').forEach(c => c.checked = false);
  updateTotal();
}

// ── Slå upp spelare ───────────────────────────────

async function lookupPlayer() {
  const name = document.getElementById('lookup-name').value.trim();
  if (!name) return;

  const container = document.getElementById('lookup-result');
  container.innerHTML = '<p style="color:var(--text3);font-size:13px">Söker...</p>';

  try {
    const r = await fetch(`/api/player/${encodeURIComponent(name)}`);
    if (!r.ok) {
      container.innerHTML = '<p style="color:var(--text3);font-size:13px">Hittades inte — kontrollera stavningen.</p>';
      return;
    }
    const data = await r.json();
    existingBetTeamIds = new Set(data.bets.map(b => b.team_id));
    updateTeamGrid(); // markera redan-satsade lag i formuläret

    const rows = data.bets.map(b => `
      <div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid rgba(42,58,80,0.4)">
        <span style="flex:1;font-size:13px;${b.eliminated ? 'opacity:0.5;text-decoration:line-through' : ''}">${b.team_name}</span>
        <span style="font-size:11px;color:var(--text3)">Gr.${b.group_name}</span>
        <span style="font-size:13px;font-weight:700;color:var(--accent)">${fmt(b.current_amount)}</span>
      </div>`).join('');

    container.innerHTML = `
      <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px">
        <div style="display:flex;justify-content:space-between;margin-bottom:10px">
          <strong>${data.player.name}</strong>
          <strong style="color:var(--accent)">${fmt(data.total)}</strong>
        </div>
        ${rows || '<p style="color:var(--text3);font-size:13px">Inga satsningar.</p>'}
      </div>`;
  } catch (e) {
    container.innerHTML = '<p style="color:var(--text3);font-size:13px">Fel vid sökning.</p>';
  }
}

document.getElementById('lookup-name')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') lookupPlayer();
});

// ── Start ─────────────────────────────────────────

fetchAll();
setInterval(fetchAll, 30000);
