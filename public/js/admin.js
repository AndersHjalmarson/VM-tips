const ROUND_LABELS = {
  r32: 'Sextondelsfinaler', r16: 'Åttondelsfinaler',
  qf: 'Kvartsfinaler', sf: 'Semifinaler',
  bronze: 'Bronsmatch', final: 'Final',
};

let token = localStorage.getItem('admin-token') || '';
let allTeams = [];
let allPlayers = [];
let allMatches = [];

// Gruppresultat: cache från API + lokala val (innan sparning)
let groupStatusCache = null;
const groupSelections = {}; // { 'A': { [teamId]: 'advanced'|'eliminated'|'uncertain' } }

// --- Auth ---

async function doLogin() {
  const pw = document.getElementById('login-password').value;
  const r = await fetch('/admin/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  });
  if (r.ok) {
    const data = await r.json();
    token = data.token;
    localStorage.setItem('admin-token', token);
    document.getElementById('login-overlay').style.display = 'none';
    loadAll();
  } else {
    const err = document.getElementById('login-error');
    err.textContent = 'Fel lösenord';
    err.classList.remove('hidden');
  }
}

function logout() {
  localStorage.removeItem('admin-token');
  location.reload();
}

document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

// --- API helpers ---

async function api(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch('/admin/api' + path, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Okänt fel');
  return data;
}

function showAlert(containerId, msg, type = 'success') {
  const el = document.getElementById(containerId);
  el.innerHTML = `<div class="alert alert-${type}">${msg}</div>`;
  setTimeout(() => { el.innerHTML = ''; }, 4000);
}

function fmt(n) {
  return n.toFixed(2).replace('.', ',') + ' kr';
}

// --- Panel navigation ---

function showPanel(name) {
  document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sidebar-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  event.currentTarget.classList.add('active');
  if (name === 'bets')          { loadBets(); updateTeamList(); }
  if (name === 'group-results') loadGroupResults();
  if (name === 'matches')       loadMatches();
  if (name === 'registration')  loadRegistrationStatus();
}

// --- Load all ---

async function loadAll() {
  await Promise.all([loadPlayers(), loadTeams()]);
  loadBets();
}

// --- Spelare ---

async function loadPlayers() {
  allPlayers = await api('/players');
  const tbody = document.getElementById('players-table-body');
  tbody.innerHTML = allPlayers.map(p => `
    <tr>
      <td><strong>${p.name}</strong></td>
      <td style="color:var(--text3);font-size:12px">${new Date(p.created_at).toLocaleDateString('sv-SE')}</td>
      <td>
        <button class="btn btn-danger btn-sm" onclick="deletePlayer(${p.id}, '${p.name.replace(/'/g, "\\'")}')">Ta bort</button>
      </td>
    </tr>
  `).join('');

  // Uppdatera dropdowns
  const sel = document.getElementById('bet-player-select');
  sel.innerHTML = allPlayers.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
}

async function addPlayer() {
  const name = document.getElementById('player-name-input').value.trim();
  if (!name) return;
  try {
    await api('/players', 'POST', { name });
    document.getElementById('player-name-input').value = '';
    showAlert('players-alert', `${name} tillagd`);
    await loadPlayers();
  } catch (e) {
    showAlert('players-alert', e.message, 'error');
  }
}

async function deletePlayer(id, name) {
  if (!confirm(`Ta bort ${name} och alla deras satsningar?`)) return;
  await api('/players/' + id, 'DELETE');
  showAlert('players-alert', `${name} borttagen`);
  await loadPlayers();
  loadBets();
}

// --- Lag ---

async function loadTeams() {
  allTeams = await api('/teams');
  updateTeamList();
  updateMatchDropdowns();
}

function updateTeamList() {
  const betType = document.getElementById('bet-type-select')?.value || 'initial';
  const container = document.getElementById('bet-teams-list');
  if (!container) return;

  const visible = betType === 'knockout'
    ? allTeams.filter(t => t.advanced_to_knockouts && !t.eliminated)
    : allTeams;

  if (visible.length === 0) {
    container.innerHTML = '<p style="color:var(--text3);padding:8px">Inga tillgängliga lag för denna typ</p>';
    return;
  }

  // Gruppera per grupp
  const byGroup = {};
  for (const t of visible) {
    if (!byGroup[t.group_name]) byGroup[t.group_name] = [];
    byGroup[t.group_name].push(t);
  }

  container.innerHTML = Object.entries(byGroup)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([g, teams]) =>
      `<div style="margin-bottom:8px">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text3);margin-bottom:3px">Grupp ${g}</div>
        ${teams.map(t => `
          <label class="team-checkbox-row">
            <input type="checkbox" class="team-checkbox" value="${t.id}">
            <span>${t.name}</span>
          </label>
        `).join('')}
      </div>`
    ).join('');
}

// --- Satsningar ---

async function loadBets() {
  let bets;
  try { bets = await api('/bets'); } catch { return; }

  const tbody = document.getElementById('bets-table-body');
  if (!tbody) return;

  tbody.innerHTML = bets.map(b => {
    const typeLabel = b.bet_type === 'knockout' ? '🟣 Slutspel' : '🔵 Grupp';
    return `
      <tr>
        <td><strong>${b.player_name}</strong></td>
        <td>${b.team_name}</td>
        <td style="color:var(--text3)">${b.group_name}</td>
        <td>${typeLabel}</td>
        <td style="color:var(--text3)">${fmt(b.original_amount)}</td>
        <td style="color:var(--accent);font-weight:700">${fmt(b.current_amount)}</td>
        <td>
          <button class="btn btn-danger btn-sm" onclick="deleteBet(${b.id})">×</button>
        </td>
      </tr>
    `;
  }).join('');
}

async function addBets() {
  const playerId = document.getElementById('bet-player-select').value;
  const betType  = document.getElementById('bet-type-select').value;
  const checked  = [...document.querySelectorAll('.team-checkbox:checked')].map(c => Number(c.value));

  if (!playerId) return showAlert('bets-alert', 'Välj en spelare', 'error');
  if (checked.length === 0) return showAlert('bets-alert', 'Välj minst ett lag', 'error');

  try {
    const result = await api('/bets/bulk', 'POST', {
      player_id: Number(playerId),
      team_ids: checked,
      bet_type: betType,
    });
    const msg = `${result.added.length} satsning(ar) registrerade` +
      (result.errors.length ? ` · ${result.errors.length} ignorerade (redan finns)` : '');
    showAlert('bets-alert', msg);
    document.querySelectorAll('.team-checkbox').forEach(c => c.checked = false);
    loadBets();
  } catch (e) {
    showAlert('bets-alert', e.message, 'error');
  }
}

async function deleteBet(id) {
  if (!confirm('Ta bort satsning?')) return;
  await api('/bets/' + id, 'DELETE');
  loadBets();
}

// --- Gruppresultat ---

async function loadGroupResults() {
  try {
    groupStatusCache = await api('/groups/status');
  } catch (e) {
    showAlert('groups-result-alert', 'Kunde inte ladda gruppdata: ' + e.message, 'error');
    return;
  }
  renderGroupResults();
}

function _effectiveTeamState(group, teamId, dbAdvanced, dbEliminated) {
  const sel = groupSelections[group]?.[teamId];
  if (sel !== undefined) return { state: sel, locked: false };
  if (dbAdvanced)  return { state: 'advanced',  locked: true };
  if (dbEliminated) return { state: 'eliminated', locked: true };
  return { state: 'uncertain', locked: false };
}

function renderGroupResults() {
  if (!groupStatusCache) return;
  const container = document.getElementById('groups-result-container');

  container.innerHTML = groupStatusCache.map(g => {

    // Badge
    let badge;
    if (g.fullyResolved) {
      badge = `<span class="badge processed-badge">Klar ✓</span>`;
    } else if (g.confirmedCount > 0) {
      badge = `<span class="badge pending-badge">${g.confirmedCount}/4 klara</span>`;
    } else {
      badge = `<span class="badge" style="background:var(--card2);color:var(--text3)">Inga resultat</span>`;
    }

    // Väntande pool
    const poolHtml = g.pendingPool > 0
      ? `<div style="font-size:12px;color:var(--accent);background:var(--card2);border:1px solid var(--border);
                     border-radius:6px;padding:8px 12px;margin-bottom:12px">
           ⏳ Väntande pool: <strong>${fmt(g.pendingPool)}</strong> — fördelas när alla fyra lag har bekräftad status
         </div>`
      : '';

    // En rad per lag
    const teamsHtml = g.teams.map(t => {
      const { state, locked } = _effectiveTeamState(g.group, t.id, t.advanced_to_knockouts, t.eliminated);

      if (locked) {
        const label = state === 'advanced' ? '✓ Vidare' : '✗ Utslaget';
        const color = state === 'advanced' ? 'var(--green)' : 'var(--red)';
        return `
          <div style="display:flex;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px solid var(--border)">
            <span style="flex:1;font-size:13px">${t.name}</span>
            <span style="font-size:12px;font-weight:700;color:${color};white-space:nowrap">${label} 🔒</span>
          </div>`;
      }

      // 3-läges knappar
      const btnStyle = s => {
        if (s === state) {
          if (s === 'advanced')  return 'background:#064e3b;color:#6ee7b7;border-color:#065f46';
          if (s === 'eliminated') return 'background:#7f1d1d;color:#fca5a5;border-color:#991b1b';
          return 'background:var(--card2);color:var(--text2);border-color:var(--accent)';
        }
        return 'background:transparent;color:var(--text3);border-color:var(--border);opacity:0.55';
      };

      return `
        <div style="display:flex;align-items:center;gap:8px;padding:7px 4px;border-bottom:1px solid var(--border)">
          <span style="flex:1;font-size:13px">${t.name}</span>
          <div style="display:flex;gap:2px;flex-shrink:0">
            <button class="btn btn-sm" style="${btnStyle('advanced')}"
              onclick="setTeamState('${g.group}',${t.id},'advanced')">✓ Vidare</button>
            <button class="btn btn-sm" style="${btnStyle('uncertain')}"
              onclick="setTeamState('${g.group}',${t.id},'uncertain')">? Oklart</button>
            <button class="btn btn-sm" style="${btnStyle('eliminated')}"
              onclick="setTeamState('${g.group}',${t.id},'eliminated')">✗ Utslaget</button>
          </div>
        </div>`;
    }).join('');

    // Spara-knapp: visa om det finns nya (ej DB-bekräftade) val
    const hasPending = !g.fullyResolved && g.teams.some(t => {
      if (t.advanced_to_knockouts || t.eliminated) return false;
      const sel = groupSelections[g.group]?.[t.id];
      return sel === 'advanced' || sel === 'eliminated';
    });

    const saveBtn = !g.fullyResolved
      ? `<button class="btn ${hasPending ? 'btn-primary' : 'btn-secondary'}"
             style="margin-top:14px" onclick="processGroup('${g.group}')"
             ${!hasPending ? 'disabled' : ''}>
           Spara för grupp ${g.group}
         </button>`
      : '';

    return `
      <div class="group-result-card">
        <h4>Grupp ${g.group} ${badge}</h4>
        ${poolHtml}
        <div>${teamsHtml}</div>
        ${saveBtn}
      </div>`;
  }).join('');
}

function setTeamState(group, teamId, state) {
  if (!groupSelections[group]) groupSelections[group] = {};
  groupSelections[group][teamId] = state;
  renderGroupResults(); // omritning utan API-anrop
}

async function processGroup(groupLetter) {
  const gData = groupStatusCache?.find(g => g.group === groupLetter);
  if (!gData) return;

  const sel = groupSelections[groupLetter] || {};
  const newAdvanced   = gData.teams.filter(t => !t.advanced_to_knockouts && !t.eliminated && sel[t.id] === 'advanced').map(t => t.id);
  const newEliminated = gData.teams.filter(t => !t.advanced_to_knockouts && !t.eliminated && sel[t.id] === 'eliminated').map(t => t.id);

  if (newAdvanced.length === 0 && newEliminated.length === 0) {
    return showAlert('groups-result-alert', 'Inga nya val att spara — markera minst ett lag', 'error');
  }

  const parts = [];
  if (newAdvanced.length)   parts.push(`${newAdvanced.length} vidare`);
  if (newEliminated.length) parts.push(`${newEliminated.length} utslagna`);

  if (!confirm(`Bekräfta för grupp ${groupLetter}: ${parts.join(', ')}?\nDetta kan inte ångras.`)) return;

  try {
    const r = await api(`/groups/${groupLetter}/results`, 'POST', {
      advanced_team_ids:  newAdvanced,
      eliminated_team_ids: newEliminated,
    });

    let msg = `Grupp ${groupLetter} uppdaterad!`;
    if (r.fullyResolved && r.totalDistributed > 0) {
      msg += ` 🎉 Hela gruppen klar — ${fmt(r.totalDistributed)} fördelades jämnt till spelarna.`;
    } else {
      if (r.newlyEliminated > 0) msg += ` ${r.newlyEliminated} lag utslaget, ${fmt(r.pendingPool)} i väntande pool.`;
      if (r.newlyAdvanced  > 0) msg += ` ${r.newlyAdvanced} lag bekräftat vidare.`;
      if (r.uncertainTeams > 0) msg += ` ${r.uncertainTeams} lag oklara — pool fördelas när alla är klara.`;
    }

    showAlert('groups-result-alert', msg);
    delete groupSelections[groupLetter];
    await loadGroupResults();
    await loadTeams();
  } catch (e) {
    showAlert('groups-result-alert', e.message, 'error');
  }
}

// --- Slutspelsmatcher ---

function updateMatchDropdowns() {
  const active = allTeams.filter(t => !t.eliminated);
  const opts = active.map(t => `<option value="${t.id}">${t.name} (Gr.${t.group_name})</option>`).join('');
  const s1 = document.getElementById('match-team1');
  const s2 = document.getElementById('match-team2');
  if (s1) s1.innerHTML = opts;
  if (s2) s2.innerHTML = opts;
}

async function loadMatches() {
  allMatches = await api('/matches');
  updateMatchDropdowns();

  const container = document.getElementById('matches-admin-list');
  if (!container) return;

  if (allMatches.length === 0) {
    container.innerHTML = '<p style="color:var(--text3)">Inga matcher skapade ännu.</p>';
    return;
  }

  const byRound = {};
  for (const m of allMatches) {
    if (!byRound[m.round]) byRound[m.round] = [];
    byRound[m.round].push(m);
  }

  const roundOrder = ['r32','r16','qf','sf','bronze','final'];
  let html = '';

  for (const round of roundOrder) {
    if (!byRound[round]) continue;
    html += `<h4 class="round-label" style="margin:16px 0 8px">${ROUND_LABELS[round]}</h4>`;

    for (const m of byRound[round]) {
      if (m.winner_id) {
        const loser = m.winner_id === m.team1_id ? m.team2_name : m.team1_name;
        html += `
          <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:6px;display:flex;align-items:center;gap:12px">
            <span style="color:var(--green);font-weight:700">✓ ${m.winner_name}</span>
            <span style="color:var(--text3)">besegrade</span>
            <span style="color:var(--text3);text-decoration:line-through">${loser}</span>
          </div>
        `;
      } else {
        html += `
          <div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin-bottom:6px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
            <span style="font-weight:600">${m.team1_name} vs ${m.team2_name}</span>
            <span style="color:var(--accent);font-size:12px">Ej spelad</span>
            <div style="margin-left:auto;display:flex;gap:6px">
              <button class="btn btn-success btn-sm" onclick="recordResult(${m.id}, ${m.team1_id}, '${m.team1_name.replace(/'/g,"\\'")}')">
                ${m.team1_name} vann
              </button>
              <button class="btn btn-success btn-sm" onclick="recordResult(${m.id}, ${m.team2_id}, '${m.team2_name.replace(/'/g,"\\'")}')">
                ${m.team2_name} vann
              </button>
            </div>
          </div>
        `;
      }
    }
  }

  container.innerHTML = html;
}

async function createMatch() {
  const t1 = Number(document.getElementById('match-team1').value);
  const t2 = Number(document.getElementById('match-team2').value);
  const round = document.getElementById('match-round').value;

  if (t1 === t2) return showAlert('matches-alert', 'Välj två olika lag', 'error');

  try {
    await api('/matches', 'POST', { team1_id: t1, team2_id: t2, round });
    showAlert('matches-alert', 'Match skapad');
    loadMatches();
  } catch (e) {
    showAlert('matches-alert', e.message, 'error');
  }
}

async function recordResult(matchId, winnerId, winnerName) {
  if (!confirm(`Bekräfta: ${winnerName} vann matchen? Detta omfördelar pengar och kan inte ångras.`)) return;

  try {
    await api(`/matches/${matchId}/result`, 'POST', { winner_id: winnerId });
    showAlert('matches-alert', `Resultat registrerat – ${winnerName} vann. Pengar omfördelade.`);
    loadMatches();
    await loadTeams();
  } catch (e) {
    showAlert('matches-alert', e.message, 'error');
  }
}

// Starta om inloggad session om token finns
// --- Registreringsstatus ---

let regStatus = { group_bets_open: true, knockout_bets_open: true };

async function loadRegistrationStatus() {
  regStatus = await api('/registration-status');
  renderRegStatus();
}

function renderRegStatus() {
  const render = (key, statusId, btnId) => {
    const open = regStatus[key];
    document.getElementById(statusId).textContent = open ? 'Öppen' : 'Stängd';
    document.getElementById(statusId).style.color = open ? 'var(--green)' : 'var(--red)';
    const btn = document.getElementById(btnId);
    btn.textContent = open ? 'Stäng satsningar' : 'Öppna satsningar';
    btn.className = 'btn btn-sm ' + (open ? 'btn-danger' : 'btn-success');
  };
  render('group_bets_open',    'group-bets-status',    'group-bets-btn');
  render('knockout_bets_open', 'knockout-bets-status', 'knockout-bets-btn');
}

async function toggleBets(type) {
  const key = type === 'group' ? 'group_bets_open' : 'knockout_bets_open';
  const label = type === 'group' ? 'gruppsatsningar' : 'slutspelssatsningar';
  const currentlyOpen = regStatus[key];
  const action = currentlyOpen ? 'stänga' : 'öppna';
  if (!confirm(`Vill du ${action} ${label}?`)) return;
  try {
    await api('/registration-status', 'POST', { [key]: !currentlyOpen });
    regStatus[key] = !currentlyOpen;
    renderRegStatus();
    showAlert('registration-alert', `${currentlyOpen ? 'Stängde' : 'Öppnade'} ${label}.`, currentlyOpen ? 'error' : 'success');
  } catch (e) {
    showAlert('registration-alert', e.message, 'error');
  }
}

async function doReset() {
  if (!confirm('Är du säker? Alla grupprocessningar och slutspelsmatcher tas bort och satsningsbeloppen återställs till original. Spelare och satsningar behålls.')) return;
  try {
    await api('/reset', 'POST');
    showAlert('reset-alert', 'Nollställt! Alla resultat är återställda.');
    await loadTeams();
  } catch (e) {
    showAlert('reset-alert', e.message, 'error');
  }
}

if (token) {
  document.getElementById('login-overlay').style.display = 'none';
  loadAll();
}
