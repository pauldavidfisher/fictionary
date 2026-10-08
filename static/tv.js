// TV screen: shows a room. Any number of TVs, anywhere, can show the same room.
const $app = document.getElementById('app');
const sock = io({ transports: ['websocket', 'polling'] });
let S = null;
let code = (params.get('r') || store.get('fx:tv') || '').toUpperCase();
let landingErr = '';

sock.on('connect', () => { if (code) sock.emit('join_tv', { code }); else render(); });
sock.on('joined', d => { code = d.code; store.set('fx:tv', code); history.replaceState(null, '', `/tv?r=${code}`); });
sock.on('state', st => { S = st; render(); });
sock.on('err', e => {
  if (e.noRoom) { code = ''; S = null; store.del('fx:tv'); history.replaceState(null, '', '/tv'); }
  landingErr = e.msg; render();
});
sock.on('ended', e => sock.listeners('err')[0]({ msg: e.msg, noRoom: true }));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && code && sock.connected) sock.emit('join_tv', { code });
});
sock.on('disconnect', () => { if (S) { S.offline = true; render(); } });

function topBar() {
  const meta = S.phase === 'lobby' ? `Room <b>${esc(S.code)}</b>` :
    S.phase === 'final' ? `Room <b>${esc(S.code)}</b> · Final` :
    `Room <b>${esc(S.code)}</b> · Round ${S.round} of ${S.rounds}`;
  const tvs = S.screens > 1 ? `<br>${S.screens} TVs connected` : '';
  return `<header class="top"><div class="brand">Fiction<span>ary</span></div><div class="meta">${meta}${tvs}${S.offline ? '<br><span class="err">Reconnecting…</span>' : ''}</div></header>`;
}

function wordBlock(size) {
  return `<div class="${size}"><div class="headword">${esc(S.word.w)}</div><div class="pos">${esc(S.word.pos)}</div></div>`;
}

const views = {
  landing() {
    return `<section class="landing">
      <div class="brand">Fiction<span>ary</span></div>
      <p class="status">The bluffing dictionary game. Everyone plays on their phone. Every house can have its own TV.</p>
      <button class="btn" id="host" data-act="host" autofocus>Host a new game</button>
      <div class="stack">
        <span class="label">Or show a game that's already running</span>
        <div class="row"><input id="code" maxlength="4" placeholder="CODE" autocomplete="off" aria-label="Room code" value="${esc(code)}">
        <button class="ghost" data-act="show">Show it on this TV</button></div>
      </div>
      ${landingErr ? `<p class="err">${esc(landingErr)}</p>` : ''}
    </section>`;
  },
  lobby() {
    const n = S.players.filter(p => p.connected).length;
    const status = n < S.minPlayers
      ? `Waiting for players. You need at least ${S.minPlayers}.`
      : `${esc(S.vipName)} starts the game from their phone.`;
    return `${topBar()}<div class="cols">
      <section class="panel">
        <span class="label">Join on your phone</span>
        <div class="row" style="gap:2rem;align-items:center">
          <img class="qr" src="/qr/${esc(S.code)}.svg" alt="QR code to join room ${esc(S.code)}">
          <div class="stack" style="gap:.4rem">
            <div class="url">${esc(S.host)}</div>
            <div class="hint">then enter the room code</div>
            <div class="code">${esc(S.code)}</div>
          </div>
        </div>
        <p class="hint">Playing from another house? On that TV, open <b>${esc(S.host)}/tv</b> and enter <b>${esc(S.code)}</b>.</p>
      </section>
      <section class="panel">
        <span class="label">Players · ${S.players.length} of 10</span>
        ${S.players.length ? people(S, 'lobby') : '<p class="hint">Nobody yet.</p>'}
        <p class="status">${status}</p>
        <p class="hint">Words: ${S.mode === 'deck' ? 'drawn from the word deck' : 'a dasher brings a real word each round'} · ${S.rounds} rounds</p>
      </section>
    </div>`;
  },
  dasher() {
    return `${topBar()}<section class="panel big" style="max-width:48rem">
      <span class="label">Round ${S.round}</span>
      <h1 style="font-size:3.6rem">${esc(S.dasherName)} is picking a word</h1>
      <p class="status">They're finding something obscure in the dictionary and typing its real definition. Nobody peek.</p>
    </section>`;
  },
  write() {
    return `${topBar()}<section class="panel big">
      <span class="label">${S.mode === 'dasher' ? `${esc(S.dasherName)} found this word` : "Tonight's word is"}</span>
      ${wordBlock('big')}
      <p class="status">Write a fake definition on your phone that's convincing enough to fool everyone.</p>
      ${people(S, 'progress')}
    </section>`;
  },
  board() {
    return `${topBar()}<section class="panel mid">
      ${wordBlock('mid')}
      <ol class="defs ${S.defs.length > 4 ? 'two' : ''}">${S.defs.map((t, k) => `<li class="def"><span class="n">${k + 1}</span><span class="t">${esc(t)}</span></li>`).join('')}</ol>
      <p class="status">One of these is real. Read each one aloud with a straight face. ${esc(S.vipName)} opens voting.</p>
    </section>`;
  },
  vote() {
    return `${topBar()}<section class="panel mid">
      ${wordBlock('mid')}
      <ol class="defs ${S.defs.length > 4 ? 'two' : ''}">${S.defs.map((t, k) => `<li class="def"><span class="n">${k + 1}</span><span class="t">${esc(t)}</span></li>`).join('')}</ol>
      <div class="row"><span class="label">Vote on your phone</span>${people(S, 'progress')}</div>
    </section>`;
  },
  reveal() {
    return `${topBar()}<div class="cols reveal">
      <section class="panel mid">${wordBlock('mid')}${revealCards(S)}
        ${S.done ? '' : `<p class="hint">${esc(S.vipName)} reveals the next one.</p>`}</section>
      <section class="panel">
        <span class="label">Scores</span>
        ${standings(S, { gains: S.done })}
        ${S.dasherBonus ? `<p class="status">Nobody found the real one. ${esc(S.dasherName)} takes 3.</p>` : ''}
        <p class="hint">${RULES}${S.mode === 'dasher' ? ' The dasher gets 3 if nobody finds the real one.' : ''}</p>
      </section>
    </div>`;
  },
  final() {
    const ranked = S.players.slice().sort((a, b) => b.score - a.score);
    const winners = ranked.filter(p => p.score === ranked[0].score).map(p => esc(p.name));
    return `${topBar()}<div class="cols">
      <section class="panel big">
        <span class="label">The most convincing liar${winners.length > 1 ? 's are' : ' is'}</span>
        <div class="winner">${winners.join(' & ')}</div>
        <p class="status">${esc(S.vipName)} can start another game from their phone.</p>
      </section>
      <section class="panel"><span class="label">Final scores</span>${standings(S)}</section>
    </div>`;
  }
};

function render() {
  $app.innerHTML = (S ? views[S.phase] : views.landing)();
  if (!S) { const b = document.getElementById(code ? 'code' : 'host'); b && b.focus(); }
}

$app.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'host') { landingErr = ''; sock.emit('create', { kind: 'tv', base: BASE }); }
  if (b.dataset.act === 'show') {
    code = document.getElementById('code').value.trim().toUpperCase();
    landingErr = code.length === 4 ? '' : 'Enter the 4-letter room code.';
    if (!landingErr) sock.emit('join_tv', { code }); else render();
  }
  wake();
});
$app.addEventListener('keydown', e => {
  if (e.target.id === 'code' && e.key === 'Enter') document.querySelector('[data-act="show"]').click();
});

// TV remotes send arrow keys: move focus between controls
document.addEventListener('keydown', e => {
  const dir = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (!dir) return;
  if (e.target.tagName === 'INPUT' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;
  const f = [...document.querySelectorAll('button:not([disabled]), input')].filter(el => el.offsetParent);
  if (!f.length) return;
  let i = f.indexOf(document.activeElement);
  f[i < 0 ? 0 : (i + dir + f.length) % f.length].focus();
  e.preventDefault();
});

// Keep the TV awake during a game where the browser allows it
let lock = null;
async function wake() { try { if (!lock && navigator.wakeLock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => lock = null); } } catch (e) {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });
wake();
render();
