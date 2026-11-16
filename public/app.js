/* Poky - browser client */
(() => {
  'use strict';

  // ---------------------------------------------------------------- helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  };

  function makeToken() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // A secret per-browser token lets you get your seat back after a refresh.
  let token = store.get('poky.token');
  if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
    token = makeToken();
    store.set('poky.token', token);
  }

  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  // ----------------------------------------------------------------- sound
  // Real recorded card & chip sounds: "Casino Audio" by Kenney (kenney.nl), CC0 public domain.
  const sound = (() => {
    const range = (name, n) => Array.from({ length: n }, (_, i) => `${name}-${i + 1}`);
    const GROUPS = {
      shuffle: ['card-shuffle'],
      deal: range('card-slide', 4),
      fold: range('card-shove', 4),
      place: range('card-place', 4),
      chip: range('chip-lay', 3),
      stack: range('chips-stack', 6),
      handle: range('chips-handle', 6),
      collide: range('chips-collide', 4),
    };
    let ctx = null;
    let master = null;
    let loading = false;
    const buffers = new Map();
    let muted = store.get('poky.muted') === '1';

    // Browsers only allow audio after the user taps or types, so this runs on the first interaction.
    function init() {
      if (ctx) {
        if (ctx.state === 'suspended') ctx.resume();
        return;
      }
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {
        return;
      }
      master = ctx.createGain();
      master.gain.value = 0.8;
      master.connect(ctx.destination);
      load();
    }

    async function load() {
      if (loading) return;
      loading = true;
      // Ogg where supported, MP3 for older Safari.
      const ext = document.createElement('audio').canPlayType('audio/ogg; codecs="vorbis"') ? 'ogg' : 'mp3';
      await Promise.all(
        Object.values(GROUPS).flat().map(async (name) => {
          try {
            const res = await fetch(`/sounds/${name}.${ext}`);
            const data = await res.arrayBuffer();
            buffers.set(name, await new Promise((ok, fail) => ctx.decodeAudioData(data, ok, fail)));
          } catch { /* a missing sound is not fatal */ }
        })
      );
    }

    const ready = () => !muted && ctx && ctx.state === 'running';

    function play(group, { delay = 0, volume = 1, maxMs = 0 } = {}) {
      if (!ready()) return;
      const names = GROUPS[group].filter((n) => buffers.has(n));
      if (!names.length) return;
      const src = ctx.createBufferSource();
      src.buffer = buffers.get(names[Math.floor(Math.random() * names.length)]);
      src.playbackRate.value = 0.94 + Math.random() * 0.12; // slight variation so repeats sound natural
      const g = ctx.createGain();
      const t = ctx.currentTime + delay / 1000;
      g.gain.setValueAtTime(volume, t);
      src.connect(g).connect(master);
      src.start(t);
      if (maxMs) {
        // Fade out and stop early (used to shorten the long shuffle recording).
        const end = t + maxMs / 1000;
        g.gain.setValueAtTime(volume, end - 0.25);
        g.gain.linearRampToValueAtTime(0.0001, end);
        src.stop(end + 0.02);
      }
    }

    /** Two soft knocks on the table: the classic "check". */
    function knock() {
      if (!ready()) return;
      for (const offset of [0, 0.13]) {
        const t = ctx.currentTime + offset;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'triangle';
        o.frequency.setValueAtTime(190, t);
        o.frequency.exponentialRampToValueAtTime(70, t + 0.08);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.55, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
        o.connect(g).connect(master);
        o.start(t);
        o.stop(t + 0.12);
      }
    }

    /** Gentle chime when it becomes your turn. */
    function ping() {
      if (!ready()) return;
      const t = ctx.currentTime;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(880, t);
      o.frequency.exponentialRampToValueAtTime(1320, t + 0.12);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.1, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + 0.32);
    }

    return {
      init,
      play,
      knock,
      ping,
      get muted() { return muted; },
      setMuted(v) {
        muted = v;
        store.set('poky.muted', v ? '1' : '0');
        if (!v) init();
      },
    };
  })();
  for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => sound.init(), { passive: true });

  /** Compare the previous and new state and play sounds for what just happened. */
  function playEventSounds(prev, s) {
    if (!prev || prev.room.code !== s.room.code) return;

    // New hand: shuffle, then cards sliding out to each player.
    if (s.handNumber > prev.handNumber && s.handInProgress) {
      sound.play('shuffle', { volume: 0.7, maxMs: 1200 });
      const players = s.seats.filter((p) => p && p.inHand).length;
      for (let i = 0; i < Math.min(players * 2, 10); i++) sound.play('deal', { delay: 650 + i * 85, volume: 0.55 });
      return;
    }

    // Player actions.
    const ev = s.lastEvent;
    if (ev && (!prev.lastEvent || ev.id !== prev.lastEvent.id)) {
      switch (ev.type) {
        case 'fold': sound.play('fold', { volume: 0.8 }); break;
        case 'check': sound.knock(); break;
        case 'call': sound.play('stack'); break;
        case 'bet':
        case 'raise':
          sound.play('stack');
          sound.play('chip', { delay: 110, volume: 0.8 });
          break;
        case 'allin':
          sound.play('handle');
          sound.play('stack', { delay: 160 });
          break;
      }
    }

    // New community cards.
    if (s.board.length > prev.board.length) {
      for (let i = 0; i < s.board.length - prev.board.length; i++) sound.play('deal', { delay: 250 + i * 120, volume: 0.8 });
    }

    // Pot pushed to the winner.
    if (s.phase === 'handOver' && prev.phase !== 'handOver' && s.result) {
      const iWon = s.me && s.result.winnings[s.me.id];
      sound.play('collide', { delay: 350, volume: iWon ? 1 : 0.7 });
      sound.play('handle', { delay: 520, volume: iWon ? 1 : 0.6 });
    }
  }

  // ----------------------------------------------------------------- state
  const socket = io();
  let roomCode = null;
  let state = null;
  let turnDeadline = null; // performance.now() timestamp
  let nextHandDeadline = null;
  let dealt = new Map(); // card key -> first time seen (for deal animations)
  let dealtHand = -1;
  let controlsKey = '';
  let requestsKey = '';
  let raiseOpen = false;
  let raiseValue = 0;
  let lastTurnKey = null;
  let busy = false;
  let pendingJoin = false;
  let chatMsgs = [];
  let unread = 0;
  let panelTab = 'chat';
  let recapSeen = null; // endedAt of the recap already shown
  const seatPos = new Map(); // player id -> {x, y} in % of the table (for bubbles and chips)
  const bubbles = new Map(); // player id -> {el, timer}
  const reducedMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ------------------------------------------------------------------ home
  const homeEl = $('#home');
  const gameEl = $('#game');
  const nameInput = $('#nameInput');
  const codeInput = $('#codeInput');

  nameInput.value = store.get('poky.name') || '';
  const urlMatch = location.pathname.match(/^\/r\/([A-Za-z0-9]{3,8})\/?$/);
  const urlCode = urlMatch ? urlMatch[1].toUpperCase() : null;
  if (urlCode) {
    codeInput.value = urlCode;
    homeEl.classList.add('invited');
    $('#inviteNote').hidden = false;
    $('#inviteCode').textContent = urlCode;
  }

  // --------------------------------------------------------------- account
  let account = null; // { id, username } when logged in; guests are null

  async function api(url, body) {
    const res = await fetch(url, body === undefined
      ? { credentials: 'same-origin' }
      : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = {};
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || data.error) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  function renderAccount() {
    const bar = $('#accountBar');
    if (account) {
      bar.innerHTML = `<button type="button" class="user-chip" data-act="myStats" title="My stats">
          <span class="avatar" aria-hidden="true">${esc(account.username[0].toUpperCase())}</span><span class="uname">${esc(account.username)}</span>
        </button>
        <button type="button" class="nav-link" data-act="logout">Log out</button>`;
    } else {
      bar.innerHTML = `<button type="button" class="nav-link" data-act="openAuth" data-mode="login">Log in</button>
        <button type="button" class="btn small primary" data-act="openAuth" data-mode="signup">Sign up</button>`;
    }
    $('#nameField').hidden = !!account; // logged-in players play under their username
  }

  async function loadAccount() {
    try {
      account = (await api('/api/me')).user || null;
    } catch {
      account = null;
    }
    renderAccount();
  }
  renderAccount();
  loadAccount();

  /** The server reads your login when the socket connects, so reconnect after logging in or out. */
  let quietReconnect = false;
  function reconnectSocket() {
    quietReconnect = true;
    socket.disconnect();
    socket.connect();
  }

  let authMode = 'login';
  function openAuth(mode = 'login') {
    authMode = mode;
    const signup = mode === 'signup';
    $('#authTabLogin').setAttribute('aria-selected', String(!signup));
    $('#authTabSignup').setAttribute('aria-selected', String(signup));
    $('#authSubmit').textContent = signup ? 'Create account' : 'Log in';
    $('#authPass').autocomplete = signup ? 'new-password' : 'current-password';
    $('#authNote').textContent = signup
      ? 'Pick a username (3–16 letters or numbers) and a password (6+ characters). Your hands, VPIP, PFR and win rates are saved from now on.'
      : 'Log in to keep your stats across games. Guests can still play without an account.';
    $('#authError').classList.add('hidden');
    const dlgA = $('#authDlg');
    if (!dlgA.open) dlgA.showModal();
    $('#authUser').focus();
  }

  $('#authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#authSubmit');
    btn.disabled = true;
    try {
      const { user } = await api(`/api/${authMode === 'signup' ? 'signup' : 'login'}`, {
        username: $('#authUser').value,
        password: $('#authPass').value,
      });
      account = user;
      $('#authPass').value = '';
      $('#authDlg').close();
      renderAccount();
      toast(authMode === 'signup' ? `Welcome to Poky, ${user.username}! 🎉` : `Welcome back, ${user.username}!`);
      reconnectSocket();
    } catch (err) {
      const el = $('#authError');
      el.textContent = err.message;
      el.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });

  async function logout() {
    try {
      await api('/api/logout', {});
    } catch { /* the cookie is cleared either way */ }
    account = null;
    renderAccount();
    toast('Logged out. You can still play as a guest.');
    reconnectSocket();
  }

  function openMyStats() {
    return openProfile(null);
  }

  /** A player's profile: all-time tiles and recent games. `username` null = you. */
  async function openProfile(username, { back = false } = {}) {
    const dlgS = $('#statsDlg');
    const backBtn = back ? '<button class="btn" data-act="profileBack">← Back</button>' : '';
    const closeRow = `<div class="dlg-actions">${backBtn}<button class="btn primary" data-act="closeStats">Close</button></div>`;
    $('#statsBody').innerHTML = `<div class="recap"><p class="recap-empty">Loading stats…</p>${closeRow}</div>`;
    if (!dlgS.open) dlgS.showModal();
    let data;
    try {
      data = await api(username ? `/api/players/${encodeURIComponent(username)}` : '/api/stats');
    } catch (err) {
      $('#statsBody').innerHTML = `<div class="recap"><p class="recap-empty">${esc(err.message)}</p>${closeRow}</div>`;
      return;
    }
    const mine = !username || (account && account.username.toLowerCase() === username.toLowerCase());
    const L = data.lifetime;
    const tile = (label, value, sub = '') =>
      `<div class="rs"><span class="rs-label">${label}</span><b class="rs-value">${value}</b><span class="rs-sub">${sub}</span></div>`;
    const tiles = [
      tile('Hands', fmt(L.hands), `${fmt(L.games)} game${L.games === 1 ? '' : 's'}`),
      tile('VPIP', pctText(L.vpip), 'money in pre-flop'),
      tile('PFR', pctText(L.pfr), 'raised pre-flop'),
      tile('Won', pctText(L.won), 'of hands'),
      tile('Showdown', pctText(L.showdown), `of ${fmt(L.showdowns || 0)} showdowns`),
      tile('Net chips', `<span class="st-net ${L.net > 0 ? 'up' : L.net < 0 ? 'down' : ''}">${signed(L.net)}</span>`, `best pot +${fmt(L.biggestWin)}`),
    ].join('');
    const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const games = data.games.length
      ? `<div class="recap-standings"><h3>Recent games</h3>${statsTable(
          data.games.map((g) => ({
            label: `${esc(g.tableName || `Table ${g.roomCode}`)}<small>${esc(day(g.lastHandAt))}</small>`,
            ...g,
          })),
          { net: true }
        )}</div>`
      : `<p class="recap-empty">${mine ? 'No hands saved yet. Play a hand while logged in and it shows up here.' : 'No hands played yet.'}</p>`;
    $('#statsBody').innerHTML = `<div class="recap">
      <div class="recap-kicker">${mine ? 'My stats' : 'Player stats'}</div>
      <h2 class="recap-title">${esc(data.user.username)}<span class="verified-badge" title="Has an account">✓</span></h2>
      <div class="recap-stats">${tiles}</div>
      ${games}
      ${closeRow}
    </div>`;
  }

  // -------------------------------------------- players: leaderboard + search
  const SORTS = [
    { key: 'net', label: 'Net chips' },
    { key: 'hands', label: 'Hands' },
    { key: 'won', label: 'Won %' },
    { key: 'showdown', label: 'Showdown %' },
    { key: 'vpip', label: 'VPIP' },
    { key: 'pfr', label: 'PFR' },
    { key: 'biggestWin', label: 'Biggest pot' },
  ];
  let boardSort = 'net';
  let playersTab = 'board';
  let reopenPlayers = false; // a profile opened from here goes "Back" to the list

  function openPlayers(tab = playersTab) {
    const d = $('#playersDlg');
    if (!d.open) d.showModal();
    switchPlayersTab(tab);
  }

  function switchPlayersTab(tab) {
    playersTab = tab;
    $('#ptBoard').setAttribute('aria-selected', String(tab === 'board'));
    $('#ptSearch').setAttribute('aria-selected', String(tab === 'search'));
    $('#boardPane').hidden = tab !== 'board';
    $('#searchPane').hidden = tab !== 'search';
    if (tab === 'board') loadBoard();
    else {
      $('#playerSearch').focus();
      runSearch();
    }
  }

  async function loadBoard() {
    $('#boardSorts').innerHTML = SORTS.map(
      (s) => `<button type="button" class="sort-chip" data-act="boardSort" data-sort="${s.key}" aria-pressed="${s.key === boardSort}">${s.label}</button>`
    ).join('');
    const body = $('#boardBody');
    body.innerHTML = '<p class="recap-empty">Loading…</p>';
    let data;
    try {
      data = await api(`/api/leaderboard?sort=${boardSort}`);
    } catch (err) {
      body.innerHTML = `<p class="recap-empty">${esc(err.message)}</p>`;
      return;
    }
    if (data.sort !== boardSort) return; // a newer sort was picked meanwhile
    const valueOf = (p) => {
      switch (boardSort) {
        case 'net': return `<span class="st-net ${p.net > 0 ? 'up' : p.net < 0 ? 'down' : ''}">${signed(p.net)}</span>`;
        case 'hands': return fmt(p.hands);
        case 'biggestWin': return `+${fmt(p.biggestWin)}`;
        default: return pctText(p[boardSort]);
      }
    };
    const rows = data.players
      .map((p, i) => `<button type="button" class="lb-row${account && p.username === account.username ? ' me' : ''}" data-act="viewPlayer" data-name="${esc(p.username)}">
          <span class="lb-rank">${i + 1}</span>
          <span class="lb-name">${esc(p.username)}<small>${fmt(p.hands)} hands · VPIP ${pctText(p.vpip)} · PFR ${pctText(p.pfr)}</small></span>
          <span class="lb-value">${valueOf(p)}</span>
        </button>`)
      .join('');
    const note = data.minHands ? `<p class="note lb-note">Players with at least ${data.minHands} hands.</p>` : '';
    body.innerHTML = rows ? `${note}<div class="lb-list">${rows}</div>` : `${note}<p class="recap-empty">Nobody on the board yet. Log in and play a few hands!</p>`;
  }

  let searchTimer = null;
  let searchSeq = 0;
  async function runSearch() {
    const q = $('#playerSearch').value.trim();
    const body = $('#searchBody');
    if (!q) {
      body.innerHTML = '<p class="recap-empty">Search by username to see anyone’s stats.</p>';
      return;
    }
    const seq = ++searchSeq;
    let data;
    try {
      data = await api(`/api/players?q=${encodeURIComponent(q)}`);
    } catch (err) {
      if (seq === searchSeq) body.innerHTML = `<p class="recap-empty">${esc(err.message)}</p>`;
      return;
    }
    if (seq !== searchSeq) return; // an older search finished after a newer one
    body.innerHTML = data.players.length
      ? `<div class="lb-list">${data.players
          .map((p) => `<button type="button" class="lb-row" data-act="viewPlayer" data-name="${esc(p.username)}">
              <span class="lb-rank">👤</span><span class="lb-name">${esc(p.username)}<small>${fmt(p.hands)} hands played</small></span><span class="lb-value">›</span>
            </button>`)
          .join('')}</div>`
      : `<p class="recap-empty">No player called “${esc(q)}”.</p>`;
  }
  $('#playerSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 200);
  });

  // ---------------------------------------------------- tap a seat: player card
  function openSeatCard(playerId) {
    const d = $('#seatDlg');
    const body = $('#seatBody');
    body.innerHTML = '<div class="seat-card"><p class="recap-empty">Loading…</p></div>';
    if (!d.open) d.showModal();
    socket.emit('playerInfo', { playerId }, async (res) => {
      if (res?.error) {
        body.innerHTML = `<div class="seat-card"><p class="recap-empty">${esc(res.error)}</p><div class="dlg-actions"><button class="btn primary" data-act="closeSeat">Close</button></div></div>`;
        return;
      }
      const info = res.info;
      const T = info.tonight;
      const statRow = (label, s, extra = '') => `<div class="sc-row"><span class="sc-label">${label}</span>
        <span class="sc-stats">
          <span><b>${s ? fmt(s.hands) : '0'}</b>hands</span>
          <span><b>${s ? pctText(s.vpip) : '–'}</b>VPIP</span>
          <span><b>${s ? pctText(s.pfr) : '–'}</b>PFR</span>
          <span><b>${s ? pctText(s.won) : '–'}</b>won</span>
          <span><b>${s ? pctText(s.showdown) : '–'}</b>SD</span>
        </span>${extra}</div>`;
      const render = (lifetime, note = '') => {
        const tonightNet = T ? `<span class="sc-net st-net ${T.net > 0 ? 'up' : T.net < 0 ? 'down' : ''}">${signed(T.net)} tonight</span>` : '';
        body.innerHTML = `<div class="seat-card">
          <div class="sc-head"><h3>${esc(info.name)}${info.username ? '<span class="verified-badge" title="Has an account">✓</span>' : ''}</h3>${tonightNet}</div>
          ${statRow('Tonight', T)}
          ${info.username ? (lifetime ? statRow('All time', lifetime) : `<p class="note">${note || 'Loading all-time stats…'}</p>`) : '<p class="note">Playing as a guest, so there are no all-time stats.</p>'}
          <div class="dlg-actions">
            ${info.username ? `<button class="btn" data-act="viewPlayer" data-name="${esc(info.username)}">Full profile</button>` : ''}
            <button class="btn primary" data-act="closeSeat">Close</button>
          </div>
        </div>`;
      };
      render(null);
      if (!info.username) return;
      try {
        const data = await api(`/api/players/${encodeURIComponent(info.username)}`);
        if (d.open) render(data.lifetime);
      } catch {
        if (d.open) render(null, 'Couldn’t load all-time stats right now.');
      }
    });
  }

  function getName() {
    if (account) return account.username;
    const n = nameInput.value.trim();
    if (!n) {
      toast('Pick a nickname first');
      nameInput.focus();
      return null;
    }
    store.set('poky.name', n);
    return n;
  }

  $('#createBtn').addEventListener('click', () => {
    const name = getName();
    if (!name) return;
    pendingJoin = true;
    socket.emit('create', { name, token }, (res) => {
      pendingJoin = false;
      if (res?.error) return toast(res.error);
      enterRoom(res.code);
    });
  });

  function joinFromHome(watch) {
    const name = getName();
    if (!name) return;
    const code = codeInput.value.trim().toUpperCase();
    if (!code) {
      toast('Enter the table code');
      codeInput.focus();
      return;
    }
    joinRoom(code, watch);
  }
  $('#joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    joinFromHome(false);
  });
  $('#watchBtn').addEventListener('click', () => joinFromHome(true));

  nameInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (urlCode || codeInput.value.trim()) $('#joinForm').requestSubmit();
    else $('#createBtn').click();
  });

  /** `watch` = come in as a spectator only; otherwise also ask for a seat (only matters the first time). */
  function joinRoom(code, watch = false) {
    const name = nameInput.value.trim() || store.get('poky.name') || '';
    pendingJoin = true;
    socket.emit('join', { code, name, token, watch }, (res) => {
      pendingJoin = false;
      if (res?.error) {
        if (!roomCode) state = null;
        toast(res.error, 3500);
        if (roomCode) leaveToHome(false);
        return;
      }
      enterRoom(res.code);
      if (res.notice) toast(res.notice, 4000);
    });
  }

  function enterRoom(code) {
    roomCode = code;
    if (location.pathname !== `/r/${code}`) history.replaceState(null, '', `/r/${code}`);
    $('#roomCode').textContent = code;
    homeEl.classList.add('hidden');
    gameEl.classList.remove('hidden');
    controlsKey = '';
    render(); // the table is visible now, so its size is known
  }

  function leaveToHome(sendLeave) {
    if (sendLeave) socket.emit('leave', {}, () => {});
    roomCode = null;
    state = null;
    controlsKey = '';
    raiseOpen = false;
    history.replaceState(null, '', '/');
    homeEl.classList.remove('invited');
    $('#inviteNote').hidden = true;
    codeInput.value = '';
    closeMenu();
    closePanel();
    chatMsgs = [];
    unread = 0;
    renderBadge();
    for (const b of bubbles.values()) clearTimeout(b.timer);
    bubbles.clear();
    $('#bubbles').innerHTML = '';
    $('#callout').classList.add('hidden');
    $('#pragySay').classList.add('hidden');
    $('#requests').classList.add('hidden');
    requestsKey = '';
    suggestActive = null;
    recapSeen = null;
    if ($('#settingsDlg').open) $('#settingsDlg').close();
    if ($('#recapDlg').open) $('#recapDlg').close();
    gameEl.classList.add('hidden');
    homeEl.classList.remove('hidden');
    document.title = 'Poky · Hold\'em with friends';
  }

  // Opening an invite link with a remembered nickname joins straight away.
  if (urlCode && nameInput.value.trim()) joinRoom(urlCode);

  // ---------------------------------------------------------------- socket
  socket.on('connect', () => {
    quietReconnect = false;
    $('#connBanner').classList.add('hidden');
    if (roomCode) joinRoom(roomCode); // re-attach after a dropped connection
  });
  socket.on('disconnect', () => {
    if (quietReconnect) return; // our own reconnect after logging in/out
    if (roomCode) $('#connBanner').classList.remove('hidden');
  });
  socket.on('kicked', () => {
    toast('The host removed you from the table.', 4000);
    leaveToHome(false);
  });
  socket.on('denied', () => toast('The host said not yet. You can keep watching.', 4000));

  /** Seat changes worth telling you about: you got a seat, or (as host) someone is asking for one. */
  function noticeSeatChanges(prev, s) {
    if (!prev || prev.room.code !== s.room.code || !prev.viewer || !s.viewer) return;
    if (prev.viewer.spectator && !s.viewer.spectator) {
      toast(s.handInProgress ? 'You’re in! You’ll be dealt in next hand.' : 'You’re in! Grab a seat 🪑', 3500);
    }
    if (s.room.hostId === s.viewer.id) {
      const before = new Set(prev.room.spectators.filter((x) => x.requested).map((x) => x.id));
      if (s.room.spectators.some((x) => x.requested && !before.has(x.id))) {
        sound.ping();
        if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
      }
    }
  }
  socket.on('state', (s) => {
    // The first state can arrive just before the join is acknowledged.
    if (!roomCode && !pendingJoin) return;
    const prev = state;
    playEventSounds(prev, s);
    detectBigMoment(prev, s);
    noticeSeatChanges(prev, s);
    const potEl = $('#center .pot');
    const potFrom = potEl ? potEl.getBoundingClientRect() : null;
    state = s;
    const now = performance.now();
    turnDeadline = s.room.turnRemainingMs != null ? now + s.room.turnRemainingMs : null;
    nextHandDeadline = s.room.nextHandInMs != null ? now + s.room.nextHandInMs : null;
    busy = false;
    render();
    celebrate(prev, s, potFrom);
    checkRecap(prev, s);
  });

  // Chat. History arrives on every (re)join; new messages arrive one by one.
  socket.on('chatHistory', (list) => {
    if (!roomCode && !pendingJoin) return;
    chatMsgs = Array.isArray(list) ? list : [];
    renderChat(true);
  });
  // Pragy the dealer says something (the server picks the line, so everyone sees the same one).
  let pragyTimer = null;
  socket.on('pragy', (line) => {
    if (!roomCode || !line || !line.text) return;
    const say = $('#pragySay');
    say.textContent = line.text;
    say.classList.remove('hidden', 'out');
    say.style.animation = 'none';
    void say.offsetWidth;
    say.style.animation = '';
    const face = $('#pragy');
    face.classList.remove('talking');
    void face.offsetWidth;
    face.classList.add('talking');
    clearTimeout(pragyTimer);
    pragyTimer = setTimeout(() => {
      say.classList.add('out');
      pragyTimer = setTimeout(() => say.classList.add('hidden'), 400);
    }, 5500);
  });

  socket.on('chat', (m) => {
    if (!roomCode && !pendingJoin) return;
    if (chatMsgs.some((x) => x.id === m.id)) return;
    chatMsgs.push(m);
    if (chatMsgs.length > 100) chatMsgs.shift();
    renderChat();
    showBubble(m);
    const mine = m.pid === myId();
    if (!mine && !(panelOpen() && panelTab === 'chat')) {
      unread++;
      renderBadge();
    }
  });

  // ---------------------------------------------------------------- render
  const tableEl = $('#table');
  // `viewer` is who you are in the room (player or spectator); `me` only exists while you have a seat.
  const myId = () => (state && state.viewer ? state.viewer.id : null);
  const isHost = () => !!state && state.room.hostId === myId();
  const isSpectator = () => !!(state && state.viewer && state.viewer.spectator);
  const mySeatObj = () => (state && state.me ? state.seats[state.me.seat] : null);
  const tableFull = () => !!state && !state.seats.includes(null);

  function render() {
    if (!state) return;
    if (state.handNumber !== dealtHand) {
      dealt = new Map();
      dealtHand = state.handNumber;
    }
    applyTheme();
    renderTopbar();
    renderTable();
    renderControls();
    renderRequests();
    if (panelOpen() && panelTab === 'log') renderLog();
    if ($('#settingsDlg').open) renderPlayerAdmin();
    notifyTurn();
  }

  const tableName = () => (state && state.settings.tableName) || '';

  /** Everyone at the table sees the theme the host picked (the host previews while choosing). */
  function applyTheme() {
    if ($('#settingsDlg').open && isHost()) return; // keep the live preview
    const theme = (state && state.settings.theme) || 'classic';
    if (gameEl.dataset.theme !== theme) gameEl.dataset.theme = theme;
  }

  function renderTopbar() {
    const s = state;
    let text;
    if (!s.room.started) text = `Lobby · ${s.seats.filter(Boolean).length} at the table`;
    else if (s.room.ended) text = '🌙 That’s a wrap for tonight';
    else if (s.room.paused) text = '⏸ Paused';
    else if (s.room.endAfterHand) text = `Last hand of the night · #${s.handNumber}`;
    else text = `Hand #${s.handNumber} · Blinds ${fmt(s.settings.smallBlind)}/${fmt(s.settings.bigBlind)}`;
    const watching = s.room.spectators.length;
    if (watching) text += ` · 👁 ${watching}`;
    $('#statusText').textContent = text;
    $('#statusText').title = watching ? `Watching: ${s.room.spectators.map((x) => x.name).join(', ')}` : '';
  }

  /** Host only: a card for each person asking for a seat, with Let in / Not now. */
  function renderRequests() {
    const el = $('#requests');
    const list = isHost() ? state.room.spectators.filter((x) => x.requested) : [];
    const full = tableFull();
    const key = JSON.stringify([list.map((x) => [x.id, x.name, x.connected]), full]);
    if (key === requestsKey) return;
    requestsKey = key;
    el.classList.toggle('hidden', list.length === 0);
    const shown = list.slice(0, 3);
    el.innerHTML =
      shown
        .map(
          (x) => `<div class="req">
            <span class="req-text"><b>${esc(x.name)}</b> wants to play${x.connected ? '' : ' <span class="muted">(offline)</span>'}</span>
            <span class="req-actions">
              <button class="btn small" data-act="deny" data-id="${esc(x.id)}">Not now</button>
              <button class="btn small primary" data-act="approve" data-id="${esc(x.id)}" ${full ? 'disabled title="The table is full"' : ''}>Let in</button>
            </span>
          </div>`
        )
        .join('') +
      (list.length > shown.length ? `<div class="req-more">+${list.length - shown.length} more waiting · see Table settings & players</div>` : '');
  }

  /** Card HTML. `key` enables a one-time deal animation for that card. */
  function cardHTML(card, key, cls = '', delay = 0) {
    let anim = '';
    if (key) {
      const now = performance.now();
      if (!dealt.has(key)) dealt.set(key, now + delay);
      const elapsed = now - dealt.get(key);
      // A negative delay continues an animation that already started, so re-renders don't restart it.
      if (elapsed < 450) anim = ` deal" style="animation-delay:${Math.round(-elapsed)}ms`;
    }
    if (!card) return `<div class="card back ${cls}${anim}"></div>`;
    const r = card[0] === 'T' ? '10' : card[0];
    const suit = card[1];
    const red = suit === 'h' || suit === 'd' ? ' red' : '';
    return `<div class="card${red} ${cls}${anim}"><span class="cr">${r}</span><span class="cs">${SUIT[suit]}</span><span class="cb">${SUIT[suit]}</span></div>`;
  }

  const TAGS = { fold: 'Fold', check: 'Check', call: 'Call', bet: 'Bet', raise: 'Raise', allin: 'All-in', sb: 'SB', bb: 'BB' };

  function renderTable() {
    const s = state;
    const portrait = tableEl.clientHeight > tableEl.clientWidth * 1.05;
    tableEl.classList.toggle('portrait', portrait);
    // Very short tables (phones held sideways) use a compact seat layout.
    tableEl.classList.toggle('short', !portrait && tableEl.clientHeight < 380);
    const RX = portrait ? 40 : 45;
    const RY = portrait ? 41 : 38;

    const mySeat = s.me ? s.me.seat : 0;
    const occupied = s.seats
      .filter(Boolean)
      .sort((a, b) => ((a.seat - mySeat + 9) % 9) - ((b.seat - mySeat + 9) % 9));
    const n = occupied.length;
    const showResult = s.phase === 'handOver' && s.result;
    const winnings = showResult ? s.result.winnings : {};
    const winCards = new Set();
    if (showResult && !s.result.uncontested) {
      const mainWinners = new Set(s.result.pots[0].winners.map((w) => w.id));
      for (const sd of s.result.showdown) if (mainWinners.has(sd.id)) sd.bestCards.forEach((c) => winCards.add(c));
    }

    let html = '';
    seatPos.clear();
    occupied.forEach((p, k) => {
      // Seats are spread evenly around the table, you at the bottom, clockwise = next to act.
      const th = (2 * Math.PI * k) / n;
      const x = 50 - RX * Math.sin(th);
      const isMe = s.me && p.id === s.me.id;
      // Your seat sits a touch higher: it has bigger cards and the hand-name pill underneath.
      const y = 50 + RY * Math.cos(th) - (isMe ? 2 : 0);
      seatPos.set(p.id, { x, y });
      const turn = s.handInProgress && s.toAct === p.seat;
      const won = winnings[p.id];

      const cls = ['seat'];
      if (isMe) cls.push('me');
      if (turn) cls.push('turn');
      if (p.folded) cls.push('folded');
      if (!p.inHand && s.room.started) cls.push('out');
      if (!p.connected) cls.push('offline');
      if (won) cls.push('winner');

      // Hole cards
      let hole = '';
      if (p.cards && p.inHand && (!p.folded || isMe || p.shown)) {
        hole = p.cards
          .map((c, i) => {
            const c2 = winCards.size ? (winCards.has(c) ? 'win' : 'dim') : '';
            return cardHTML(c, `${s.handNumber}:${c}`, p.folded ? 'dim' : c2, i * 120);
          })
          .join('');
      } else if (p.hasCards) {
        hole = cardHTML(null, `${s.handNumber}:${p.seat}:b0`, '', 0) + cardHTML(null, `${s.handNumber}:${p.seat}:b1`, '', 120);
      }

      // Status tag
      let tag = '';
      if (won) tag = `<div class="tag tag-win">+${fmt(won)}</div>`;
      else if (p.lastAction && p.inHand) tag = `<div class="tag tag-${p.lastAction.type}">${TAGS[p.lastAction.type] || ''}</div>`;
      else if (p.stack === 0 && !p.inHand && s.room.started) tag = '<div class="tag tag-out">Busted</div>';
      else if (p.sittingOut) tag = '<div class="tag tag-out">Sitting out</div>';
      else if (!p.inHand && s.handInProgress) tag = '<div class="tag tag-out">Next hand</div>';

      let timer = '';
      if (turn && turnDeadline != null && s.settings.turnTime > 0) {
        const remaining = Math.max(0, turnDeadline - performance.now());
        const start = clamp(remaining / (s.settings.turnTime * 1000), 0, 1);
        timer = `<div class="timer"><i style="--start:${start.toFixed(3)};animation-duration:${Math.round(remaining)}ms"></i></div>`;
      }

      const star = p.id === s.room.hostId ? '<span class="host-star" title="Host">★</span>' : '';
      const offline = p.connected ? '' : '<span class="offline-dot" title="Offline"></span>';
      const verified = (s.room.verified || []).includes(p.id) ? '<span class="verified" title="Playing with an account">✓</span>' : '';
      // Your hand name sits under your cards. Its space is kept while you hold cards so the seat doesn't jump.
      let myHand = '';
      if (isMe && p.inHand && p.cards && s.handInProgress) {
        const hn = s.me.handName;
        myHand = `<div class="my-hand${hn ? '' : ' empty'}">${hn ? esc(hn) : '&nbsp;'}</div>`;
      }
      html += `<div class="${cls.join(' ')}" style="left:${x}%;top:${y}%">
        ${isMe ? suggestHTML(s) : ''}
        <div class="hole">${hole}</div>
        <div class="plate" data-act="seatInfo" data-id="${esc(p.id)}" title="See ${esc(p.name)}’s stats">
          <div class="name">${star}${esc(p.name)}${verified}${offline}</div>
          <div class="stack">${fmt(p.stack)}</div>
          ${timer}
        </div>
        ${isMe ? `<div class="me-foot">${myHand}${tag}</div>` : tag}
      </div>`;

      if (p.bet > 0) {
        const bx = 50 + (x - 50) * 0.56;
        const by = 50 + (y - 50) * 0.52;
        html += `<div class="bet" style="left:${bx}%;top:${by}%"><span class="chip"></span>${fmt(p.bet)}</div>`;
      }
      if (s.room.started && p.seat === s.buttonSeat && s.handNumber > 0) {
        const t2 = th - 0.42;
        const dx = 50 - RX * 0.7 * Math.sin(t2);
        const dy = 50 + RY * 0.66 * Math.cos(t2);
        html += `<div class="dealer" style="left:${dx}%;top:${dy}%" title="Dealer button">D</div>`;
      }
    });
    $('#seats').innerHTML = html;
    positionBubbles();

    renderCenter(winCards);
  }

  function renderCenter(winCards) {
    const s = state;
    const center = $('#centerBody');
    $('#pragy').classList.toggle('hidden', !s.room.started);

    if (!s.room.started) {
      const count = s.seats.filter(Boolean).length;
      const hostName = (s.seats.find((p) => p && p.id === s.room.hostId) || {}).name || 'the host';
      center.innerHTML = `<div class="lobby">
        ${tableName() ? `<div class="lobby-name">${esc(tableName())}</div>` : ''}
        <div class="lobby-title">Table code</div>
        <div class="lobby-code">${esc(s.room.code)}</div>
        <div class="lobby-sub">${count} player${count === 1 ? '' : 's'} at the table${s.room.spectators.length ? ` · ${s.room.spectators.length} watching` : ''} · ${fmt(s.settings.startingStack)} chips · blinds ${fmt(s.settings.smallBlind)}/${fmt(s.settings.bigBlind)}</div>
        <div class="lobby-actions">
          <button class="btn small" data-act="invite">Copy invite link</button>
          ${isHost() ? '<button class="btn small" data-act="settings">Settings</button>' : ''}
        </div>
        ${
          isHost()
            ? `<button class="btn primary" data-act="start" ${count < 2 ? 'disabled' : ''}>${count < 2 ? 'Waiting for players…' : 'Start game'}</button>`
            : `<div class="lobby-sub muted">Waiting for ${esc(hostName)} to start the game…</div>`
        }
      </div>`;
      return;
    }

    // Board (5 slots)
    let board = '';
    for (let i = 0; i < 5; i++) {
      const c = s.board[i];
      if (c) {
        const extra = winCards.size ? (winCards.has(c) ? 'win' : 'dim') : '';
        const delay = i < 3 ? i * 110 : 0;
        board += cardHTML(c, `${s.handNumber}:${c}`, extra, delay);
      } else board += '<div class="slot"></div>';
    }

    let pot = '';
    if (s.handInProgress) {
      const total = s.pot + s.seats.reduce((sum, p) => sum + (p ? p.bet : 0), 0);
      if (total > 0) pot = `<div class="pot"><span class="chip gold"></span>Pot ${fmt(total)}</div>`;
    }

    let msg = '';
    if (s.room.paused) {
      msg = '<div class="msg"><b>Game paused</b></div>';
    } else if (s.phase === 'handOver' && s.result) {
      msg = `<div class="msg">${resultLines(s.result).map((l) => `<div class="msg-line">${l}</div>`).join('')}${nextHandLine()}</div>`;
    } else if (!s.handInProgress) {
      msg = `<div class="msg">${nextHandLine() || waitingLine()}</div>`;
    }

    const name = tableName() ? `<div class="felt-name">${esc(tableName())}</div>` : '';
    center.innerHTML = `${name}<div class="board">${board}</div>${pot}${msg}`;
  }

  function nextHandLine() {
    if (state.room.ended) return '<div class="next-in">That’s a wrap for tonight 🌙</div>';
    if (nextHandDeadline != null) {
      const sec = Math.max(0, Math.ceil((nextHandDeadline - performance.now()) / 1000));
      return `<div class="next-in">Next hand in <span id="nextIn">${sec}</span>…</div>`;
    }
    if (state.room.started && !state.handInProgress) return `<div class="next-in">${waitingLine()}</div>`;
    return '';
  }

  function waitingLine() {
    return 'Waiting for at least 2 players with chips…';
  }

  function resultLines(r) {
    if (r.uncontested) {
      const w = r.pots[0].winners[0];
      return [`<b>${esc(w.name)}</b> wins ${fmt(w.amount)}`];
    }
    return r.pots.map((pot, i) => {
      const label = r.pots.length > 1 ? `<span class="muted">${i === 0 ? 'Main pot' : `Side pot${r.pots.length > 2 ? ' ' + i : ''}`}:</span> ` : '';
      const names = pot.winners.map((w) => `<b>${esc(w.name)}</b>`).join(' & ');
      const verb = pot.winners.length > 1 ? 'split' : 'wins';
      return `${label}${names} ${verb} ${fmt(pot.amount)} <span class="muted">· ${esc(pot.handName)}</span>`;
    });
  }

  // -------------------------------------------------------------- controls
  function controlStatus() {
    const s = state;
    const me = s.me;
    const p = mySeatObj();
    if (!p) {
      const v = s.viewer;
      if (!v || !v.spectator) return '';
      if (v.requested) return 'Waiting for the host to let you in…';
      return tableFull() ? 'You’re watching. The table is full right now.' : 'You’re watching.';
    }
    if (!s.room.started) return isHost() ? 'You’re the host. Start when everyone has joined.' : 'Waiting for the host to start…';
    if (s.room.ended) return 'The night is over. Thanks for playing!';
    if (s.room.paused) return 'The game is paused.';
    const inHandNow = s.handInProgress && p.inHand;
    if (p.stack === 0 && !inHandNow) return s.settings.allowRebuys ? 'You’re out of chips.' : 'You’re out of chips (rebuys are off).';
    if (p.sittingOut && !inHandNow) return 'You’re sitting out.';
    if (s.handInProgress) {
      if (!p.inHand) return 'You’ll be dealt in next hand.';
      if (p.folded) return 'You folded this hand.';
      if (p.allIn) return 'You’re all-in.';
      const t = s.seats[s.toAct];
      if (t && t.id !== me.id) return `Waiting for ${t.name}…`;
    }
    return '';
  }

  function renderControls() {
    const s = state;
    const me = s.me;
    const p = mySeatObj();
    const L = me && me.legal;
    if (!L) raiseOpen = false;
    const status = controlStatus();
    const key = JSON.stringify([s.viewer, tableFull(), s.settings.requireApproval, L, me && me.handName, me && me.canShow, status, raiseOpen, p && [p.stack, p.sittingOut, p.inHand], s.settings.allowRebuys, s.room.started, s.room.ended, s.handInProgress, s.currentBet === 0, p && s.currentBet > p.bet]);
    if (key === controlsKey) {
      updateTimerText();
      return;
    }
    controlsKey = key;

    // Your hand name now lives under your cards on the table; the bar just says whose turn it is.
    const lead = L ? '<span class="hand-name">Your turn</span>' : `<span class="status">${esc(status)}</span>`;
    let html = `<div class="controls-inner"><div class="ctl-info">${lead}${L ? '<span class="ctl-timer" id="myTimer"></span>' : ''}</div>`;

    if (L) {
      if (raiseOpen && L.raise) {
        raiseValue = clamp(raiseValue || L.raise.min, L.raise.min, L.raise.max);
        html += `<div class="raise-panel">
          <div class="quick">
            <button class="btn" data-act="quick" data-f="min">Min</button>
            <button class="btn" data-act="quick" data-f="0.5">½ Pot</button>
            <button class="btn" data-act="quick" data-f="0.75">¾ Pot</button>
            <button class="btn" data-act="quick" data-f="1">Pot</button>
            <button class="btn" data-act="quick" data-f="max">All-in</button>
          </div>
          <div class="raise-row">
            <button class="btn" data-act="step" data-d="-1" aria-label="Less">−</button>
            <input type="range" id="raiseRange" min="${L.raise.min}" max="${L.raise.max}" step="1" value="${raiseValue}" aria-label="Raise amount">
            <button class="btn" data-act="step" data-d="1" aria-label="More">+</button>
            <input type="number" id="raiseNum" min="${L.raise.min}" max="${L.raise.max}" value="${raiseValue}" inputmode="numeric" aria-label="Raise to">
          </div>
        </div>`;
      }
      const callLabel = L.canCheck
        ? 'Check'
        : L.toCall >= p.stack
          ? `All-in <small>${fmt(L.toCall)}</small>`
          : `Call <small>${fmt(L.toCall)}</small>`;
      const callAct = L.canCheck ? 'check' : 'call';
      let raiseBtn = '';
      if (L.raise) {
        raiseBtn = raiseOpen
          ? `<button class="btn act raise" data-act="raise" id="raiseBtn"></button>`
          : `<button class="btn act raise" data-act="openRaise">${L.raise.isBet ? 'Bet' : 'Raise'}${L.raise.min === L.raise.max ? ` <small>All-in ${fmt(L.raise.max)}</small>` : ''}</button>`;
      }
      if (!L.raise) raiseBtn = `<button class="btn act raise" disabled>Raise</button>`;
      html += `<div class="actions">
        <button class="btn act fold" data-act="fold">Fold</button>
        <button class="btn act call" data-act="${callAct}">${callLabel}</button>
        ${raiseBtn}
      </div>`;
    } else {
      // Not your turn: the same row stays in place (greyed out), so the page never jumps.
      // Rebuy / sit back in / show cards take that same spot when they apply.
      const extra = [];
      const v = s.viewer;
      if (!p && v && v.spectator) {
        // Watching: ask for a seat (or sit straight down if you've been let in before).
        if (v.requested) extra.push('<button class="btn" data-act="cancelRequest">Cancel my request</button>');
        else if (tableFull()) extra.push('<button class="btn" disabled>Table is full</button>');
        else {
          const direct = v.approved || !s.settings.requireApproval;
          extra.push(`<button class="btn primary" data-act="requestSeat">${direct ? 'Take a seat' : 'Ask to play'}</button>`);
        }
      }
      if (p) {
        const inHandNow = s.handInProgress && p.inHand;
        if (me.canShow) extra.push('<button class="btn" data-act="show">Show my cards</button>');
        if (!s.room.ended) {
          if (s.room.started && p.stack === 0 && !inHandNow && s.settings.allowRebuys) {
            extra.push(`<button class="btn gold" data-act="rebuy">Rebuy ${fmt(s.settings.startingStack)}</button>`);
          }
          if (p.sittingOut && p.stack > 0) extra.push('<button class="btn primary" data-act="sitin">I’m back, deal me in</button>');
        }
      }
      if (extra.length) {
        html += `<div class="ctl-extra">${extra.join('')}</div>`;
      } else {
        const facingBet = p && s.handInProgress && p.inHand && s.currentBet > p.bet;
        html += `<div class="actions idle" aria-hidden="true">
          <button class="btn act fold" disabled tabindex="-1">Fold</button>
          <button class="btn act call" disabled tabindex="-1">${facingBet ? 'Call' : 'Check'}</button>
          <button class="btn act raise" disabled tabindex="-1">${s.handInProgress && s.currentBet === 0 ? 'Bet' : 'Raise'}</button>
        </div>`;
      }
    }
    html += '</div>';
    $('#controls').innerHTML = html;

    if (raiseOpen && L && L.raise) {
      const range = $('#raiseRange');
      const num = $('#raiseNum');
      range.addEventListener('input', () => setRaise(snap(Number(range.value), L), false));
      num.addEventListener('change', () => setRaise(Number(num.value), true));
      num.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          setRaise(Number(num.value), true);
          sendAction('raise', raiseValue);
        }
      });
      setRaise(raiseValue, true);
    }
    updateTimerText();
  }

  /** Snap slider values to multiples of the small blind (except at the ends). */
  function snap(v, L) {
    if (v >= L.raise.max) return L.raise.max;
    if (v <= L.raise.min) return L.raise.min;
    const step = state.settings.smallBlind;
    return clamp(Math.round(v / step) * step, L.raise.min, L.raise.max);
  }

  function setRaise(v, updateRange) {
    const L = state && state.me && state.me.legal;
    if (!L || !L.raise) return;
    if (!Number.isFinite(v)) v = L.raise.min;
    raiseValue = clamp(Math.round(v), L.raise.min, L.raise.max);
    const range = $('#raiseRange');
    const num = $('#raiseNum');
    if (range && updateRange) range.value = raiseValue;
    if (num && document.activeElement !== num) num.value = raiseValue;
    const btn = $('#raiseBtn');
    if (btn) {
      const allIn = raiseValue === L.raise.max;
      btn.innerHTML = allIn ? `All-in <small>${fmt(raiseValue)}</small>` : `${L.raise.isBet ? 'Bet' : 'Raise to'} <small>${fmt(raiseValue)}</small>`;
    }
  }

  function quickAmount(f) {
    const s = state;
    const L = s.me.legal;
    if (f === 'min') return L.raise.min;
    if (f === 'max') return L.raise.max;
    const potTotal = s.pot + s.seats.reduce((sum, p) => sum + (p ? p.bet : 0), 0);
    // Pot-sized raise = call first, then raise by the size of the pot.
    return Math.round(s.currentBet + Number(f) * (potTotal + L.toCall));
  }

  function sendAction(type, amount) {
    if (busy) return;
    busy = true;
    raiseOpen = false;
    socket.emit('action', { type, amount }, (res) => {
      if (res?.error) {
        busy = false;
        toast(res.error);
        controlsKey = '';
        render();
      }
    });
  }

  function updateTimerText() {
    const el = $('#myTimer');
    if (el) {
      if (turnDeadline != null) {
        const sec = Math.max(0, Math.ceil((turnDeadline - performance.now()) / 1000));
        el.textContent = `${sec}s`;
        el.classList.toggle('low', sec <= 5);
      } else el.textContent = '';
    }
    const ni = $('#nextIn');
    if (ni && nextHandDeadline != null) ni.textContent = Math.max(0, Math.ceil((nextHandDeadline - performance.now()) / 1000));
  }
  setInterval(updateTimerText, 250);

  function notifyTurn() {
    const myTurn = !!(state.me && state.me.legal);
    const key = myTurn ? `${state.handNumber}:${state.toAct}:${state.actionCount}` : null;
    if (myTurn && key !== lastTurnKey) {
      if (navigator.vibrate) navigator.vibrate(120);
      sound.ping();
    }
    lastTurnKey = key;
    document.title = myTurn ? '● Your turn · Poky' : `Poky · ${tableName() || `Table ${state.room.code}`}`;
  }

  // ------------------------------------------------------- big moments
  const BIG_HANDS = { 6: 'a Full House', 7: 'Four of a Kind', 8: 'a Straight Flush' };

  /** When a hand ends: slide the pot to the winner(s), and call out a big hand. */
  function celebrate(prev, s, potFrom) {
    if (!prev || prev.room.code !== s.room.code) return;
    if (!(s.phase === 'handOver' && prev.phase !== 'handOver' && s.result)) return;
    if (!reducedMotion()) flyPot(s, potFrom);
    bigHandCallout(s);
  }

  function flyPot(s, from) {
    const fx = $('#fx');
    const tr = tableEl.getBoundingClientRect();
    if (!tr.width || !fx.animate) return;
    const start = from && from.width
      ? { x: from.left + from.width / 2 - tr.left, y: from.top + from.height / 2 - tr.top }
      : { x: tr.width / 2, y: tr.height / 2 };
    Object.entries(s.result.winnings)
      .filter(([, amt]) => amt > 0)
      .forEach(([pid, amt], i) => {
        const pos = seatPos.get(pid);
        if (!pos) return;
        const el = document.createElement('div');
        el.className = 'pot-fly';
        el.innerHTML = '<span class="chip gold"></span><span class="chip gold"></span><span class="chip gold"></span>' +
          `<b>${fmt(amt)}</b>`;
        el.style.left = `${start.x}px`;
        el.style.top = `${start.y}px`;
        fx.appendChild(el);
        const dx = (pos.x / 100) * tr.width - start.x;
        const dy = (pos.y / 100) * tr.height - start.y;
        const to = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        const anim = el.animate(
          [
            { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 },
            { transform: `${to} scale(0.9)`, opacity: 1, offset: 0.8 },
            { transform: `${to} scale(0.7)`, opacity: 0 },
          ],
          { duration: 1000, delay: 300 + i * 180, easing: 'cubic-bezier(.45,0,.2,1)', fill: 'both' }
        );
        anim.onfinish = anim.oncancel = () => el.remove();
      });
  }

  function bigHandCallout(s) {
    if (s.result.uncontested) return;
    const winners = new Set(s.result.pots.flatMap((p) => p.winners.map((w) => w.id)));
    let best = null;
    for (const sd of s.result.showdown) {
      if (winners.has(sd.id) && sd.category >= 6 && (!best || sd.category > best.category)) best = sd;
    }
    if (!best) return;
    const what = best.handName === 'Royal Flush' ? 'a Royal Flush' : BIG_HANDS[best.category];
    showCallout(`${best.name} hits ${what}! ${best.category >= 7 ? '🔥' : '🎉'}`);
  }

  let calloutTimer = null;
  function showCallout(text) {
    const el = $('#callout');
    clearTimeout(calloutTimer);
    calloutTimer = setTimeout(() => {
      el.textContent = text;
      el.classList.remove('hidden');
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
      calloutTimer = setTimeout(() => el.classList.add('hidden'), 3800);
    }, 700);
  }

  // ----------------------------------------------------------- recap
  /** Show the recap when the host ends the night (after the last hand's result has been seen). */
  function checkRecap(prev, s) {
    const dlgR = $('#recapDlg');
    if (!s.room.ended) {
      if (dlgR.open && dlgR.dataset.final === '1') dlgR.close();
      recapSeen = null;
      return;
    }
    if (recapSeen === s.room.endedAt) return;
    recapSeen = s.room.endedAt;
    const justFinished = prev && prev.phase !== 'handOver' && s.phase === 'handOver';
    setTimeout(() => {
      if (state && state.room.ended && state.room.endedAt === recapSeen) openRecap(state.room.recap, true);
    }, justFinished ? 3200 : 300);
  }

  function signed(n) {
    return `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}`;
  }

  const pctText = (v) => (v == null ? '–' : `${v}%`);
  const STAT_HELP = {
    vpip: 'VPIP: how often you put money in before the flop by choice (calls and raises; blinds don’t count)',
    pfr: 'PFR: how often you raised before the flop',
    won: 'Won: share of your hands that you won',
    sd: 'Showdown: share of showdowns you won',
  };

  /** A small table: one row per item { label, hands, vpip, pfr, won, showdown, net? }. */
  function statsTable(rows, { net = false } = {}) {
    const head = `<tr><th></th><th>Hands</th><th title="${STAT_HELP.vpip}">VPIP</th><th title="${STAT_HELP.pfr}">PFR</th>` +
      `<th title="${STAT_HELP.won}">Won</th><th title="${STAT_HELP.sd}"><span class="long">Showdown</span><span class="short">SD</span></th>${net ? '<th>Net</th>' : ''}</tr>`;
    const body = rows
      .map((r) => `<tr><td class="st-label">${r.label}</td><td>${fmt(r.hands)}</td><td>${pctText(r.vpip)}</td><td>${pctText(r.pfr)}</td>` +
        `<td>${pctText(r.won)}</td><td>${pctText(r.showdown)}</td>${net ? `<td class="st-net ${r.net > 0 ? 'up' : r.net < 0 ? 'down' : ''}">${signed(r.net)}</td>` : ''}</tr>`)
      .join('');
    return `<div class="stat-table-wrap"><table class="stat-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  function openRecap(r, final) {
    if (!r || !state) return;
    const dlgR = $('#recapDlg');
    const name = tableName() || 'Poker night';
    const date = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    let body = '';
    if (!r.hands) {
      body = '<p class="recap-empty">No hands played yet.</p>';
    } else {
      const stat = (label, value, sub) =>
        `<div class="rs"><span class="rs-label">${label}</span><b class="rs-value">${value}</b><span class="rs-sub">${sub}</span></div>`;
      const stats = [];
      if (r.biggestPot) {
        stats.push(stat('Biggest pot', fmt(r.biggestPot.amount),
          `${esc(r.biggestPot.winners.join(' & '))}${r.biggestPot.handName ? ` · ${esc(r.biggestPot.handName)}` : ''}`));
      }
      if (r.bestHand) stats.push(stat('Best hand', esc(r.bestHand.name), esc(r.bestHand.player)));
      if (r.mostWins) stats.push(stat('Most hands won', esc(r.mostWins.name), `${r.mostWins.count} hand${r.mostWins.count === 1 ? '' : 's'}`));
      const titles = r.titles
        .map((t) => `<div class="rt"><span class="rt-emoji">${t.emoji}</span><span class="rt-text"><b>${esc(t.title)}</b> <span>${esc(t.name)}</span></span><span class="rt-detail">${esc(t.detail)}</span></div>`)
        .join('');
      const standings = r.standings
        .map((p, i) => `<div class="st-row"><span class="st-rank">${i + 1}</span><span class="st-name">${esc(p.name)}</span><span class="st-net ${p.net > 0 ? 'up' : p.net < 0 ? 'down' : ''}">${signed(p.net)}</span></div>`)
        .join('');
      const statRows = r.standings.filter((p) => p.stats && p.stats.hands > 0);
      const playerTable = statRows.length
        ? `<div class="recap-standings"><h3>Player stats</h3>${statsTable(
            statRows.map((p) => ({ label: esc(p.name), ...p.stats }))
          )}</div>`
        : '';
      body = `<div class="recap-stats">${stats.join('')}</div>
        ${titles ? `<div class="recap-titles">${titles}</div>` : ''}
        ${standings ? `<div class="recap-standings"><h3>Standings</h3>${standings}</div>` : ''}
        ${playerTable}`;
    }
    const keepPlaying = final && isHost() ? '<button class="btn" data-act="continueNight">Keep playing</button>' : '';
    $('#recapBody').innerHTML = `<div class="recap">
      <div class="recap-kicker">${final ? 'That’s a wrap' : 'So far tonight'}</div>
      <h2 class="recap-title">${esc(name)}</h2>
      <div class="recap-date">${esc(date)} · ${r.hands} hand${r.hands === 1 ? '' : 's'} played</div>
      ${body}
      <div class="dlg-actions">
        ${r.hands ? '<button class="btn" data-act="copyRecap">Copy summary</button>' : ''}
        ${keepPlaying}
        <button class="btn primary" data-act="closeRecap">Close</button>
      </div>
    </div>`;
    dlgR.dataset.final = final ? '1' : '0';
    lastRecap = r;
    if (!dlgR.open) dlgR.showModal();
  }
  let lastRecap = null;

  function recapText(r) {
    const lines = [`🃏 ${tableName() || 'Poker night'} · ${r.hands} hands`];
    if (r.biggestPot) lines.push(`💰 Biggest pot: ${fmt(r.biggestPot.amount)} (${r.biggestPot.winners.join(' & ')})`);
    if (r.bestHand) lines.push(`🏆 Best hand: ${r.bestHand.name} (${r.bestHand.player})`);
    if (r.mostWins) lines.push(`🔁 Most hands won: ${r.mostWins.name} (${r.mostWins.count})`);
    for (const t of r.titles) lines.push(`${t.emoji} ${t.title}: ${t.name} (${t.detail})`);
    if (r.standings.length) lines.push('', ...r.standings.map((p, i) => `${i + 1}. ${p.name} ${signed(p.net)}`));
    return lines.join('\n');
  }

  // ------------------------------------------------------------ chat
  const panel = $('#sidePanel');
  const panelOpen = () => !panel.classList.contains('hidden');
  const coarse = () => window.matchMedia && matchMedia('(pointer: coarse)').matches;

  function openPanel(tab) {
    panel.classList.remove('hidden');
    gameEl.classList.add('panel-open');
    switchTab(tab || panelTab);
  }
  function closePanel() {
    panel.classList.add('hidden');
    gameEl.classList.remove('panel-open');
  }
  function switchTab(tab) {
    panelTab = tab;
    $('#tabChat').setAttribute('aria-selected', String(tab === 'chat'));
    $('#tabLog').setAttribute('aria-selected', String(tab === 'log'));
    $('#chatPane').classList.toggle('hidden', tab !== 'chat');
    $('#logPane').classList.toggle('hidden', tab !== 'log');
    if (tab === 'chat') {
      unread = 0;
      renderBadge();
      renderChat(true);
      if (!coarse()) $('#chatInput').focus();
    } else if (state) {
      renderLog();
      $('#logList').scrollTop = $('#logList').scrollHeight;
    }
  }

  function renderBadge() {
    const b = $('#chatBadge');
    b.textContent = unread > 9 ? '9+' : String(unread);
    b.classList.toggle('hidden', unread === 0);
    $('#chatBtn').setAttribute('aria-label', unread ? `Chat (${unread} unread)` : 'Chat');
  }

  function renderChat(forceBottom = false) {
    if (!panelOpen() || panelTab !== 'chat') return;
    const list = $('#chatList');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    const me = myId();
    list.innerHTML = chatMsgs.length
      ? chatMsgs
          .map((m) => `<div class="cm${m.pid === me ? ' mine' : ''}"><span class="cm-name">${m.spectator ? '<span title="Watching">👁</span> ' : ''}${esc(m.name)}</span><span class="cm-text">${esc(m.text)}</span></div>`)
          .join('')
      : '<div class="chat-empty">No messages yet. Say hi 👋</div>';
    if (atBottom || forceBottom) list.scrollTop = list.scrollHeight;
  }

  /** Phrases from phrases.js: { happy: [...], sad: [...] } (a plain list also works, as "happy"). */
  const PHRASES = (() => {
    const raw = window.POKY_PHRASES;
    const list = (v) => (Array.isArray(v) ? v.filter((p) => typeof p === 'string' && p.trim()) : []);
    if (Array.isArray(raw)) return { happy: list(raw), sad: [] };
    return { happy: list(raw && raw.happy), sad: list(raw && raw.sad) };
  })();
  const ALL_PHRASES = [...PHRASES.happy, ...PHRASES.sad];

  function renderPhrases() {
    $('#phrases').innerHTML = `<div class="phrase-row">${ALL_PHRASES
      .map((p, i) => `<button type="button" class="phrase" data-act="phrase" data-i="${i}">${esc(p)}</button>`)
      .join('')}</div>`;
    $('#phrases').hidden = ALL_PHRASES.length === 0;
  }
  renderPhrases();

  // ---- 3 suggested phrases above your own cards, only around big moments
  const SUGGEST_MS = 8000;
  const GREAT_HAND = /^(Straight|Flush|Full House|Four of a Kind|Royal Flush)/; // straight or better
  let suggestKey = null;
  let suggestions = [];
  let suggestHiddenUntil = 0;
  let suggestActive = null; // { mood, until, id } while a big moment is on
  let suggestSeq = 0;
  let suggestEndTimer = null;

  function triggerSuggest(mood, ms = SUGGEST_MS) {
    suggestActive = { mood, until: performance.now() + ms, id: ++suggestSeq };
    clearTimeout(suggestEndTimer);
    suggestEndTimer = setTimeout(() => state && renderTable(), ms + 50);
  }

  const potTotal = (s) => s.pot + s.seats.reduce((sum, p) => sum + (p ? p.bet : 0), 0);

  /** Look at what just happened and decide whether it's a big moment worth suggesting phrases for. */
  function detectBigMoment(prev, s) {
    if (!prev || !s.me || prev.room.code !== s.room.code) return;
    if (s.handNumber !== prev.handNumber) suggestActive = null; // new hand, fresh start
    const bb = s.settings.bigBlind;
    const me = s.seats[s.me.seat];
    if (!me) return;

    // A hand just finished.
    if (s.phase === 'handOver' && prev.phase !== 'handOver' && s.result) {
      const r = s.result;
      const total = r.pots.reduce((sum, pot) => sum + pot.amount, 0);
      const winnerIds = new Set(r.pots.flatMap((pot) => pot.winners.map((w) => w.id)));
      const bestCat = Math.max(-1, ...r.showdown.filter((sd) => winnerIds.has(sd.id)).map((sd) => sd.category));
      const big = total >= 20 * bb || bestCat >= 4;
      const iWon = r.winnings[me.id] > 0;
      if (me.inHand && me.stack === 0) triggerSuggest('sad', 10000); // busted
      else if (big && me.inHand) triggerSuggest(iWon ? 'happy' : 'sad');
      else if (big) triggerSuggest('happy');
      return;
    }
    if (!s.handInProgress || s.handNumber !== prev.handNumber) return;

    // A large raise or an all-in.
    const ev = s.lastEvent;
    if (ev && (!prev.lastEvent || ev.id !== prev.lastEvent.id)) {
      const actor = s.seats[ev.seat];
      const amount = actor && actor.lastAction ? actor.lastAction.amount || 0 : 0;
      const largeRaise = (ev.type === 'raise' || ev.type === 'bet') && amount >= Math.max(5 * bb, 0.5 * potTotal(prev));
      if (ev.type === 'allin' || largeRaise) triggerSuggest('happy');
    }

    // You just made a great hand.
    const had = prev.me && prev.me.handName;
    const now = s.me.handName;
    if (me.inHand && !me.folded && now && GREAT_HAND.test(now) && !(had && GREAT_HAND.test(had))) triggerSuggest('happy');
  }

  function pickSome(list, n) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, n);
  }

  /** HTML for the suggestion chips (empty when there is nothing to suggest). */
  function suggestHTML(s) {
    const t = performance.now();
    if (!s.room.started || s.room.ended || t < suggestHiddenUntil) return '';
    if (!suggestActive || t > suggestActive.until) return '';
    const mood = suggestActive.mood;
    // New picks for every big moment and on every street (preflop, flop, turn, river, result).
    const key = `${suggestActive.id}:${s.handNumber}:${s.board.length}:${s.phase === 'handOver'}`;
    if (key !== suggestKey) {
      suggestKey = key;
      const pool = PHRASES[mood].length ? PHRASES[mood] : ALL_PHRASES;
      suggestions = pickSome(pool, 3);
    }
    if (!suggestions.length) return '';
    return `<div class="suggest ${mood}">${suggestions
      .map((p) => `<button type="button" class="sg" data-act="suggest" data-text="${esc(p)}">${esc(p)}</button>`)
      .join('')}</div>`;
  }

  /** Hide the suggestions while your own speech bubble is up, then bring them back. */
  let suggestTimer = null;
  function pauseSuggestions(ms) {
    suggestHiddenUntil = performance.now() + ms;
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(() => state && renderTable(), ms + 50);
    if (state) renderTable();
  }

  function sendChat(text, onFail) {
    text = String(text || '').trim();
    if (!text || !roomCode) return;
    socket.emit('chat', { text }, (res) => {
      if (res?.error) {
        toast(res.error);
        if (onFail) onFail();
      }
    });
  }

  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#chatInput');
    const text = input.value;
    input.value = '';
    sendChat(text, () => {
      if (!input.value) input.value = text;
    });
  });

  /** A speech bubble above the sender's seat for a few seconds. */
  function showBubble(m) {
    const old = bubbles.get(m.pid);
    if (old) {
      clearTimeout(old.timer);
      old.el.remove();
    }
    const el = document.createElement('div');
    el.className = 'bubble';
    el.innerHTML = `<span>${esc(m.text)}</span>`;
    $('#bubbles').appendChild(el);
    const b = { el, timer: 0 };
    b.timer = setTimeout(() => {
      el.classList.add('out');
      b.timer = setTimeout(() => {
        el.remove();
        if (bubbles.get(m.pid) === b) bubbles.delete(m.pid);
      }, 450);
    }, 4500);
    bubbles.set(m.pid, b);
    positionBubbles();
    if (state && state.me && m.pid === state.me.id) pauseSuggestions(4900);
  }

  function positionBubbles() {
    for (const [pid, b] of bubbles) {
      const pos = seatPos.get(pid);
      b.el.hidden = !pos;
      if (!pos) continue;
      b.el.style.left = `${pos.x}%`;
      b.el.style.top = `${pos.y}%`;
      b.el.classList.toggle('below', pos.y < 30);
    }
  }

  // ------------------------------------------------------------ menu & UI
  const menu = $('#menu');
  const menuBtn = $('#menuBtn');
  function closeMenu() {
    menu.classList.add('hidden');
    menuBtn.setAttribute('aria-expanded', 'false');
  }
  function openMenu() {
    if (!state) return;
    const p = mySeatObj();
    const items = [];
    items.push('<button data-act="log">Hand log</button>');
    if (state.room.started) items.push('<button data-act="stats">📊 Tonight’s stats</button>');
    items.push(account ? '<button data-act="myStats">📈 My stats (all games)</button>' : '<button data-act="openAuth" data-mode="login">🔐 Log in to save my stats</button>');
    items.push('<button data-act="openPlayers">🏆 Leaderboard & players</button>');
    items.push(`<button data-act="settings">${isHost() ? 'Table settings & players' : 'Table info'}</button>`);
    items.push('<button data-act="invite">Copy invite link</button>');
    items.push(`<button data-act="toggleSound">${sound.muted ? '🔇 Sound: off' : '🔊 Sound: on'}</button>`);
    if (p && state.room.started) {
      items.push(p.sittingOut ? '<button data-act="sitin">Sit back in</button>' : '<button data-act="sitout">Sit out next hand</button>');
    }
    if (p) items.push('<button data-act="standUp">👁 Stand up and watch</button>');
    else if (isSpectator()) {
      const v = state.viewer;
      if (v.requested) items.push('<button data-act="cancelRequest">Cancel my seat request</button>');
      else if (!tableFull()) items.push(`<button data-act="requestSeat">${v.approved || !state.settings.requireApproval ? '🪑 Take a seat' : '🪑 Ask to play'}</button>`);
    }
    if (isHost() && state.room.started && !state.room.ended) {
      items.push(state.room.paused ? '<button data-act="resume">Resume game</button>' : '<button data-act="pause">Pause game</button>');
    }
    if (isHost() && state.room.started) {
      if (state.room.ended || state.room.endAfterHand) {
        items.push(`<button data-act="continueNight">${state.room.ended ? 'Keep playing' : 'Don’t end the night'}</button>`);
      } else items.push('<button data-act="endNight">🌙 End the night</button>');
    }
    items.push('<hr><button class="danger" data-act="leave">Leave table</button>');
    menu.innerHTML = items.join('');
    menu.classList.remove('hidden');
    menuBtn.setAttribute('aria-expanded', 'true');
  }
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) openMenu();
    else closeMenu();
  });

  function host(cmd, extra = {}) {
    socket.emit('host', { cmd, ...extra }, (res) => {
      if (res?.error) toast(res.error);
    });
  }

  async function invite() {
    if (!roomCode) return;
    const url = `${location.origin}/r/${roomCode}`;
    const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    if (coarse && navigator.share) {
      try {
        const name = tableName();
        await navigator.share({
          title: name || 'Join my poker table',
          text: name ? `Join ${name} on Poky (code ${roomCode})` : `Join my Poky table (code ${roomCode})`,
          url,
        });
        return;
      } catch { /* cancelled; fall through to copy */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied. Send it to your friends!');
    } catch {
      window.prompt('Copy this invite link:', url);
    }
  }

  function renderLog() {
    const list = $('#logList');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.innerHTML = state.log.map((l) => `<div class="${l.text.startsWith('—') ? 'hand' : ''}">${esc(l.text)}</div>`).join('');
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  // ------------------------------------------------------------- settings
  const dlg = $('#settingsDlg');
  const form = $('#settingsForm');

  function openSettings() {
    const s = state;
    const cur = s.pendingSettings || s.settings;
    const hostMode = isHost();
    $('#settingsTitle').textContent = hostMode ? 'Table settings' : 'Table info';
    form.startingStack.value = cur.startingStack;
    form.smallBlind.value = cur.smallBlind;
    form.bigBlind.value = cur.bigBlind;
    form.turnTime.value = cur.turnTime;
    form.allowRebuys.checked = cur.allowRebuys;
    form.requireApproval.checked = s.settings.requireApproval !== false;
    form.theme.value = s.settings.theme || 'classic';
    form.tableName.value = s.settings.tableName || '';
    for (const el of form.querySelectorAll('input')) el.disabled = !hostMode;
    $('#saveSettings').hidden = !hostMode;
    let note = '';
    if (!hostMode) note = 'Only the host can change these.';
    else if (s.handInProgress) note = 'The table name and style change right away. Chip and blind changes start from the next hand.';
    else if (s.handNumber === 0) note = 'Changing starting chips sets everyone’s stack before the first hand. Later it only applies to new players and rebuys.';
    else note = 'Starting chips apply to new players and rebuys.';
    $('#settingsNote').textContent = note;
    renderPlayerAdmin();
    dlg.showModal();
  }

  function renderPlayerAdmin() {
    const hostMode = isHost();
    const kickBtn = (p) =>
      hostMode && p.id !== myId() ? `<button type="button" class="btn small" data-act="kick" data-id="${esc(p.id)}" data-name="${esc(p.name)}">Remove</button>` : '';
    const tagsFor = (p, more = []) =>
      [p.id === state.room.hostId ? 'host' : '', p.id === myId() ? 'you' : '', p.connected ? '' : 'offline', ...more].filter(Boolean).join(', ');
    const rows = state.seats
      .filter(Boolean)
      .map((p) => {
        const tags = tagsFor(p);
        return `<div class="player-row"><span>${esc(p.name)} <span class="muted">${tags ? `(${tags}) ` : ''}· ${fmt(p.stack)}</span></span>${kickBtn(p)}</div>`;
      })
      .join('');
    const watchers = state.room.spectators
      .map((p) => {
        const tags = tagsFor(p, [p.requested ? 'wants to play' : '']);
        const decide = hostMode && p.requested
          ? `<button type="button" class="btn small" data-act="deny" data-id="${esc(p.id)}">Not now</button>` +
            `<button type="button" class="btn small primary" data-act="approve" data-id="${esc(p.id)}" ${tableFull() ? 'disabled' : ''}>Let in</button>`
          : '';
        return `<div class="player-row"><span>👁 ${esc(p.name)}${tags ? ` <span class="muted">(${tags})</span>` : ''}</span><span class="row-actions">${decide}${kickBtn(p)}</span></div>`;
      })
      .join('');
    $('#playerAdmin').innerHTML = `<h3>Players</h3>${rows}${watchers ? `<h3>Watching</h3>${watchers}` : ''}`;
  }

  // Live preview while the host picks a style; closing without saving reverts it.
  form.addEventListener('change', (e) => {
    if (e.target.name === 'theme' && isHost()) gameEl.dataset.theme = e.target.value;
  });
  dlg.addEventListener('close', () => {
    if (state) {
      gameEl.dataset.theme = state.settings.theme || 'classic';
      applyTheme();
    }
  });

  form.addEventListener('submit', (e) => {
    if (!e.submitter || e.submitter.value !== 'save') return; // "Close" just closes
    e.preventDefault();
    const settings = {
      startingStack: Number(form.startingStack.value),
      smallBlind: Number(form.smallBlind.value),
      bigBlind: Number(form.bigBlind.value),
      turnTime: Number(form.turnTime.value),
      allowRebuys: form.allowRebuys.checked,
      requireApproval: form.requireApproval.checked,
      theme: form.theme.value,
      tableName: form.tableName.value,
    };
    socket.emit('host', { cmd: 'settings', settings }, (res) => {
      if (res?.error) return toast(res.error, 3500);
      dlg.close();
      // The new state arrives before this reply, so we can check the server really applied it.
      if (state && state.settings.theme !== settings.theme) {
        toast('Saved, but the server didn’t apply the table style. Try restarting the server.', 5000);
      } else toast('Settings saved');
    });
  });

  // ---------------------------------------------------------- click router
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) closeMenu();
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    if (menu.contains(el)) closeMenu();
    const act = el.dataset.act;
    const L = state && state.me && state.me.legal;
    switch (act) {
      case 'invite': invite(); break;
      case 'toggleSound':
        sound.setMuted(!sound.muted);
        toast(sound.muted ? 'Sound off' : 'Sound on');
        break;
      case 'start': host('start'); break;
      case 'pause': host('pause'); break;
      case 'resume': host('resume'); break;
      case 'settings': closeMenu(); openSettings(); break;
      case 'log': closeMenu(); openPanel('log'); break;
      case 'chat': if (panelOpen()) closePanel(); else openPanel('chat'); break;
      case 'tab': switchTab(el.dataset.tab); break;
      case 'closePanel': closePanel(); break;
      case 'phrase': {
        const phrase = ALL_PHRASES[Number(el.dataset.i)];
        if (phrase) sendChat(phrase);
        break;
      }
      case 'suggest':
        if (el.dataset.text) sendChat(el.dataset.text);
        break;
      case 'show':
        socket.emit('show', {}, (res) => res?.error && toast(res.error));
        break;
      case 'stats':
        closeMenu();
        if (state.room.ended && state.room.recap) openRecap(state.room.recap, true);
        else socket.emit('recap', {}, (res) => (res?.error ? toast(res.error) : openRecap(res.recap, false)));
        break;
      case 'endNight':
        if (confirm(state.handInProgress ? 'End the night after this hand? Everyone will see the recap.' : 'End the night now? Everyone will see the recap.')) host('end');
        break;
      case 'continueNight':
        host('continue');
        if ($('#recapDlg').open) $('#recapDlg').close();
        break;
      case 'closeRecap': $('#recapDlg').close(); break;
      case 'copyRecap':
        if (lastRecap) {
          navigator.clipboard.writeText(recapText(lastRecap)).then(
            () => toast('Summary copied. Paste it in the group chat!'),
            () => toast('Couldn’t copy. Take a screenshot instead 📸')
          );
        }
        break;
      case 'leave':
        if (confirm(isSpectator() ? 'Leave the table?' : 'Leave the table? You’ll give up your seat and chips.')) leaveToHome(true);
        break;
      case 'openAuth': closeMenu(); openAuth(el.dataset.mode); break;
      case 'authMode': openAuth(el.dataset.mode); break;
      case 'closeAuth': $('#authDlg').close(); break;
      case 'logout': logout(); break;
      case 'myStats': closeMenu(); reopenPlayers = false; openMyStats(); break;
      case 'closeStats': $('#statsDlg').close(); reopenPlayers = false; break;
      case 'openPlayers': closeMenu(); openPlayers(); break;
      case 'closePlayers': $('#playersDlg').close(); break;
      case 'playersTab': switchPlayersTab(el.dataset.tab); break;
      case 'boardSort': boardSort = el.dataset.sort; loadBoard(); break;
      case 'viewPlayer': {
        // From the list: "Back" returns to it. From a seat card: just the profile.
        reopenPlayers = $('#playersDlg').open;
        if (reopenPlayers) $('#playersDlg').close();
        if ($('#seatDlg').open) $('#seatDlg').close();
        openProfile(el.dataset.name, { back: reopenPlayers });
        break;
      }
      case 'profileBack':
        $('#statsDlg').close();
        reopenPlayers = false;
        openPlayers();
        break;
      case 'seatInfo': openSeatCard(el.dataset.id); break;
      case 'closeSeat': $('#seatDlg').close(); break;
      case 'requestSeat':
        socket.emit('requestSeat', {}, (res) => res?.error && toast(res.error, 3500));
        break;
      case 'cancelRequest':
        socket.emit('cancelRequest', {}, (res) => res?.error && toast(res.error));
        break;
      case 'standUp': {
        const inHand = state.handInProgress && mySeatObj()?.inHand && !mySeatObj()?.folded;
        const msg = inHand ? 'Stand up and watch? You’ll fold this hand. Your chips are kept for when you sit back down.' : 'Stand up and watch? Your chips are kept for when you sit back down.';
        if (confirm(msg)) socket.emit('standUp', {}, (res) => res?.error && toast(res.error));
        break;
      }
      case 'approve':
        host('approve', { playerId: el.dataset.id });
        break;
      case 'deny':
        host('deny', { playerId: el.dataset.id });
        break;
      case 'kick':
        if (confirm(`Remove ${el.dataset.name} from the table?`)) host('kick', { playerId: el.dataset.id });
        break;
      case 'rebuy':
        socket.emit('rebuy', {}, (res) => res?.error && toast(res.error));
        break;
      case 'sitout':
        socket.emit('sitout', { value: true }, (res) => res?.error ? toast(res.error) : toast('You’ll sit out from the next hand.'));
        break;
      case 'sitin':
        socket.emit('sitout', { value: false }, (res) => res?.error && toast(res.error));
        break;
      case 'fold': if (L) sendAction('fold'); break;
      case 'check': if (L) sendAction('check'); break;
      case 'call': if (L) sendAction('call'); break;
      case 'openRaise':
        if (L && L.raise) {
          if (L.raise.min === L.raise.max) sendAction('allin');
          else {
            raiseOpen = true;
            raiseValue = L.raise.min;
            controlsKey = '';
            renderControls();
          }
        }
        break;
      case 'raise': if (L && L.raise) sendAction(raiseValue >= L.raise.max ? 'allin' : 'raise', raiseValue); break;
      case 'quick': if (L && L.raise) setRaise(quickAmount(el.dataset.f), true); break;
      case 'step':
        if (L && L.raise) setRaise(raiseValue + Number(el.dataset.d) * state.settings.bigBlind, true);
        break;
    }
  });

  // Keyboard shortcuts on desktop: F = fold, C = check/call, R = raise, Esc = close.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenu();
      if (panelOpen() && !document.querySelector('dialog[open]')) closePanel();
      if (raiseOpen) {
        raiseOpen = false;
        controlsKey = '';
        renderControls();
      }
      return;
    }
    if (!state || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.matches('input, textarea') || document.querySelector('dialog[open]')) return;
    const L = state.me && state.me.legal;
    if (!L) return;
    const k = e.key.toLowerCase();
    if (k === 'f') sendAction('fold');
    else if (k === 'c') sendAction(L.canCheck ? 'check' : 'call');
    else if (k === 'r' && L.raise) {
      if (raiseOpen) sendAction(raiseValue >= L.raise.max ? 'allin' : 'raise', raiseValue);
      else $('[data-act="openRaise"]')?.click();
    }
  });

  // Re-layout seats when the table changes size (window resize, or the chat panel opening on desktop).
  let resizeRaf = 0;
  const relayout = () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => state && renderTable());
  };
  if (window.ResizeObserver) new ResizeObserver(relayout).observe(tableEl);
  else window.addEventListener('resize', relayout);
})();
