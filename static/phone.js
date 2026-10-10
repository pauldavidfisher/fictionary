// Phone controller: join, write a bluff, vote. The VIP also runs the game from here.
const $ = id => document.getElementById(id);
const sock = io({ transports: ['websocket', 'polling'] });
let S = null, lastKey = null, editing = false, joinErr = '';
let pid = store.get('fx:pid');
if (!pid) { pid = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()); store.set('fx:pid', pid); }
let session = { code: store.get('fx:room') || '', name: store.get('fx:name') || '' };
const urlCode = (params.get('r') || '').toUpperCase();
if (urlCode && urlCode !== session.code) session = { code: urlCode, name: session.name, fresh: true };

sock.on('connect', () => {
  if (session.code && session.name && !session.fresh) sock.emit('join', { code: session.code, name: session.name, pid });
  else render();
});
sock.on('joined', d => {
  session = { code: d.code, name: d.name }; pid = d.pid;
  store.set('fx:room', d.code); store.set('fx:name', d.name); store.set('fx:pid', d.pid);
  history.replaceState(null, '', '/');
});
sock.on('state', st => {
  if (editing && S && S.me && st.me && st.me.myText !== S.me.myText) editing = false;
  if (S && st.phase !== S.phase) editing = false;
  S = st; S.offline = false; render();
});
sock.on('err', e => {
  if (e.noRoom) { S = null; store.del('fx:room'); session.code = ''; session.fresh = true; joinErr = e.msg; lastKey = null; render(); }
  else toast(e.msg);
});
sock.on('ended', e => sock.listeners('err')[0]({ msg: e.msg, noRoom: true }));
// A tab left in the background can miss updates: check in again when it comes back
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S && sock.connected) sock.emit('join', { code: S.code, name: S.me.name, pid });
});
sock.on('kicked', e => { S = null; store.del('fx:room'); session.fresh = true; joinErr = e.msg; lastKey = null; render(); });
sock.on('left', () => { S = null; store.del('fx:room'); session.fresh = true; session.code = ''; lastKey = null; render(); });
sock.on('deck_word', w => { $('dw').value = w.w; $('dp').value = w.pos; $('dd').value = w.d; });
sock.on('disconnect', () => { if (S) { S.offline = true; renderMeta(); } });

let toastTimer;
function toast(msg, ok) {
  $('toast').innerHTML = `<div class="toast${ok ? ' ok' : ''}" role="${ok ? 'status' : 'alert'}">${esc(msg)}</div>`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').innerHTML = '', 4500);
}

const word = (size = '') => `<div><div class="headword" ${size}>${esc(S.word.w)}</div><div class="pos">${esc(S.word.pos)}</div></div>`;
const vipBox = inner => `<div class="vip"><span class="label">★ You run the game</span>${inner}</div>`;
const waitingNames = () => S.players.filter(p => p.waiting).map(p => esc(p.name));

const views = {
  join() {
    return {
      key: 'join' + joinErr,
      main: `<span class="label">Join a game</span>
        <label class="field"><span>Room code</span><input id="jc" class="code-in" maxlength="4" autocomplete="off" autocapitalize="characters" value="${esc(session.code)}"></label>
        <label class="field"><span>Your name</span><input id="jn" maxlength="16" autocomplete="nickname" value="${esc(session.name)}"></label>
        ${joinErr ? `<p class="sub" style="color:#c0392b;font-weight:600">${esc(joinErr)}</p>` : ''}
        <button class="btn big" data-act="join">Join</button>
        <p class="sub">The code is on the TV. No TV yet? Start a game here and anyone can join with the code, from anywhere.</p>
        <button class="ghost" data-act="create">Start a new game</button>`
    };
  },
  lobby() {
    const me = S.me, n = S.players.filter(p => p.connected).length;
    let main = `<span class="label">Room ${esc(S.code)}</span><h2>You're in, ${esc(me.name)}</h2>`;
    if (me.vip) {
      main += `<div class="field"><span>Where the words come from</span><div class="seg">
          <button data-act="mode" data-v="deck" aria-pressed="${S.mode === 'deck'}"><b>Word deck</b><small>The game draws an obscure word.</small></button>
          <button data-act="mode" data-v="dasher" aria-pressed="${S.mode === 'dasher'}"><b>Dasher picks</b><small>Players take turns bringing a real word.</small></button></div></div>
        <label class="field"><span>Rounds</span><select id="rounds">${[3, 5, 7, 10].map(r => `<option ${r === S.rounds ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
        <button class="btn big" data-act="start" ${n < S.minPlayers ? 'disabled' : ''}>${n < S.minPlayers ? `Need ${S.minPlayers - n} more player${S.minPlayers - n > 1 ? 's' : ''}` : `Start game with ${n} players`}</button>`;
    } else {
      main += `<p class="sub">${esc(S.vipName)} will start the game. ${S.mode === 'deck' ? 'Words come from the deck' : 'Players take turns as dasher'}, ${S.rounds} rounds.</p>`;
    }
    main += `<button class="ghost" data-act="invite">Invite someone to room ${esc(S.code)}</button>
      <p class="sub">Friends somewhere else can join with code <b>${esc(S.code)}</b> at ${esc(S.host)}. To put the game on another TV, open <b>${esc(S.host)}/tv</b> on it.</p>`;
    return { key: `lobby${me.vip}${S.mode}${S.rounds}${n}`, main, status: playersBox(me.vip) };
  },
  dasher() {
    const me = S.me;
    if (me.dasher) return {
      key: 'dasher-me' + S.round,
      main: `<span class="label">Round ${S.round} · You're the dasher</span><h2>Pick a real word</h2>
        <p class="sub">Choose a word nobody here knows. Type its true definition in plain dictionary style.</p>
        <label class="field"><span>Word</span><input id="dw" maxlength="30" autocomplete="off"></label>
        <label class="field"><span>Part of speech</span><select id="dp">${['n.', 'v.', 'adj.', 'adv.', 'interj.'].map(p => `<option>${p}</option>`).join('')}</select></label>
        <label class="field"><span>Real definition</span><textarea id="dd" maxlength="160"></textarea></label>
        <button class="btn big" data-act="dasherGo">Use this word</button>
        <button class="ghost" data-act="dasherDeck">Fill from the word deck</button>`,
      vip: me.vip ? vipBox(`<button class="ghost" data-act="force">Skip and use a deck word</button>`) : ''
    };
    return {
      key: 'dasher' + S.round,
      main: `<span class="label">Round ${S.round}</span><h2>${esc(S.dasherName)} is picking a word</h2><p class="sub">Get ready to bluff.</p>`,
      vip: me.vip ? vipBox(`<button class="ghost" data-act="force">${esc(S.dasherName)} is stuck? Use a deck word</button>`) : ''
    };
  },
  write() {
    const me = S.me;
    let key, main;
    if (!me.playing) { key = 'w-out'; main = `<h2>You're in for the next round</h2><p class="sub">This round started before you joined.</p>`; }
    else if (me.dasher) { key = 'w-dash' + S.word.w; main = `<span class="label">You're the dasher</span>${word()}<p class="sub">Real definition: <b>${esc(me.real)}</b></p><p class="sub">Everyone else is writing bluffs. You score 3 if nobody finds the real one.</p>`; }
    else if (me.myText && !editing) { key = 'w-done' + S.word.w + me.myText; main = `<span class="label">Locked in</span>${word()}<div class="locked">${esc(me.myText)}</div><button class="ghost" data-act="edit">Change it</button>`; }
    else {
      key = 'w-edit' + S.word.w + S.round;
      main = `<span class="label">Round ${S.round} · Write a bluff</span>${word()}
        <label class="field"><span>Your fake definition</span><textarea id="fake" maxlength="160" placeholder="a small brass hook once used to…">${esc(me.myText || '')}</textarea></label>
        <p class="count" id="cnt">${(me.myText || '').length} / 160</p>
        <p class="sub">Write it the way a dictionary would. Short, plain and specific fools people best.</p>
        <button class="btn big" data-act="submit">Lock it in</button>`;
    }
    const w = waitingNames();
    const status = `<p class="sub" style="text-align:center">${w.length ? `Waiting on ${w.join(', ')}` : 'Everyone is in'}</p>`;
    const vip = me.vip ? vipBox(`<button class="ghost" data-act="newWord">Someone knows this word</button>
      ${w.length && S.fakes > 0 ? `<button class="ghost" data-act="force">Continue without ${w.join(', ')}</button>` : ''}`) : '';
    return { key, main, status, vip };
  },
  board() {
    return {
      key: 'board' + S.round + S.word.w,
      main: `<span class="label">Read these aloud</span>${word()}${defList()}`,
      vip: S.me.vip ? vipBox(`<p class="sub">When everyone has heard them all:</p><button class="btn big" data-act="startVote">Open voting</button>`) : ''
    };
  },
  vote() {
    const me = S.me, w = waitingNames();
    let key, main;
    if (!me.writer) { key = 'v-watch' + S.round; main = `<span class="label">Voting</span>${word()}${defList()}<p class="sub">${me.dasher ? "You're the dasher, so you sit this vote out." : "You'll play next round."}</p>`; }
    else if (me.voted !== null) { key = 'v-done' + S.round; main = `<span class="label">Vote in</span>${word()}<p class="sub">You picked number ${me.voted + 1}.</p>${defList()}`; }
    else {
      key = 'v-pick' + S.round + S.word.w;
      main = `<span class="label">Which one is real?</span>${word()}<p class="sub">Your own bluff is hidden.</p>
        <div class="stack" style="gap:8px">${S.defs.map((t, k) => k === me.mine ? '' : `<button class="opt" data-act="vote" data-k="${k}"><span class="n">${k + 1}</span><span>${esc(t)}</span></button>`).join('')}</div>`;
    }
    return {
      key, main,
      status: `<p class="sub" style="text-align:center">${w.length ? `Waiting on ${w.join(', ')}` : 'All votes in'}</p>`,
      vip: me.vip && w.length ? vipBox(`<button class="ghost" data-act="force">Reveal without ${w.join(', ')}</button>`) : ''
    };
  },
  reveal() {
    const me = S.me;
    return {
      key: 'reveal' + S.round + S.step,
      main: `<span class="label">The reveal</span>${word()}${revealCards(S).replace(' two', '').replace(' wide', '')}`,
      status: `<div class="card"><span class="label">Scores</span>${standings(S, { gains: S.done })}
        ${S.dasherBonus ? `<p class="sub">Nobody found the real one. ${esc(S.dasherName)} takes 3.</p>` : ''}</div>`,
      vip: me.vip ? vipBox(S.done
        ? `<button class="btn big" data-act="next">${S.round >= S.rounds ? 'Final results' : 'Next round'}</button>`
        : `<button class="btn big" data-act="reveal">${S.step === S.steps - 1 ? 'Reveal the real one' : 'Reveal next'}</button>`) : ''
    };
  },
  final() {
    const ranked = S.players.slice().sort((a, b) => b.score - a.score);
    const winners = ranked.filter(p => p.score === ranked[0].score).map(p => esc(p.name));
    return {
      key: 'final' + S.me.vip,
      main: `<span class="label">Game over</span><p class="sub">The most convincing liar${winners.length > 1 ? 's are' : ' is'}</p><h2>${winners.join(' & ')}</h2>${standings(S)}`,
      vip: S.me.vip ? vipBox(`<button class="btn big" data-act="start">Play again, same players</button><button class="ghost" data-act="toLobby">Change settings</button>`) : ''
    };
  }
};

function defList() {
  return `<ol class="defs">${S.defs.map((t, k) => `<li class="def ${k === S.me.mine ? 'mine' : ''}"><span class="n">${k + 1}</span><span class="t">${esc(t)}${k === S.me.mine ? '<span class="tag">Yours</span>' : ''}</span></li>`).join('')}</ol>`;
}

function playersBox(isVip) {
  return `<div class="stack" style="gap:8px"><span class="label">Players · ${S.players.length} of 10</span>
    <div class="people">${S.players.map(p => `<span class="person ${p.connected ? '' : 'away'}">${p.vip ? '<span class="star">★</span>' : ''}${esc(p.name)}${isVip && !p.vip ? ` <button class="ghost" style="padding:0 6px;border:0" data-act="remove" data-pid="${esc(p.pid)}" aria-label="Remove ${esc(p.name)}">✕</button>` : ''}</span>`).join('')}</div></div>`;
}

function renderMeta() {
  $('meta').innerHTML = !S ? '' :
    `Room ${esc(S.code)} · ${esc(S.me.name)}${S.phase !== 'lobby' && S.phase !== 'final' ? `<br>Round ${S.round} of ${S.rounds}` : ''}${S.offline ? '<br><span style="color:var(--danger)">Reconnecting…</span>' : ''}`;
  $('foot').innerHTML = S && (S.phase === 'lobby' || S.phase === 'final') ? `<button data-act="leave">Leave this game</button>` : '';
}

function render() {
  const v = S ? views[S.phase]() : views.join();
  if (v.key !== lastKey) {
    lastKey = v.key;
    $('main').innerHTML = v.main;
    const f = $('main').querySelector('#fake, #jn:placeholder-shown, #dw');
    if (f && v.key.startsWith('w-edit')) f.focus();
  }
  $('status').innerHTML = v.status || '';
  $('vip').innerHTML = v.vip || '';
  renderMeta();
}

const A = {
  join() {
    const code = $('jc').value.trim().toUpperCase(), name = $('jn').value.trim();
    if (code.length !== 4) return toast('Enter the 4-letter room code from the TV.');
    if (!name) return toast('Enter your name.');
    joinErr = ''; session = { code, name }; sock.emit('join', { code, name, pid });
  },
  create() {
    const name = $('jn').value.trim();
    if (!name) return toast('Enter your name first.');
    joinErr = ''; session = { code: '', name }; sock.emit('create', { kind: 'phone', name, pid, base: BASE });
  },
  mode(b) { sock.emit('settings', { mode: b.dataset.v }); },
  start() { sock.emit('start'); },
  toLobby() { sock.emit('to_lobby'); },
  leave() { sock.emit('leave'); },
  async invite() {
    const url = S.joinUrl;
    const text = `Join my Fictionary game! Room ${S.code}`;
    try {
      if (navigator.share) { await navigator.share({ title: 'Fictionary Party', text, url }); return; }
      await navigator.clipboard.writeText(`${text}: ${url}`);
      toast('Invite link copied. Paste it into a text or email.', true);
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // they closed the share sheet
      toast(`Share this link: ${url}`, true);
    }
  },
  remove(b) { sock.emit('remove', { pid: b.dataset.pid }); },
  dasherDeck() { sock.emit('dasher_deck'); },
  dasherGo() { sock.emit('dasher_word', { w: $('dw').value, pos: $('dp').value, d: $('dd').value }); },
  newWord() { sock.emit('new_word'); },
  edit() { editing = true; lastKey = null; render(); },
  submit() { sock.emit('submit', { text: $('fake').value }); },
  force() { sock.emit('force'); },
  startVote() { sock.emit('start_vote'); },
  vote(b) { sock.emit('vote', { k: +b.dataset.k }); },
  reveal() { sock.emit('reveal'); },
  next() { sock.emit('next'); }
};

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (b && A[b.dataset.act]) A[b.dataset.act](b);
});
document.addEventListener('change', e => { if (e.target.id === 'rounds') sock.emit('settings', { rounds: +e.target.value }); });
document.addEventListener('input', e => { if (e.target.id === 'fake') $('cnt').textContent = `${e.target.value.length} / 160`; });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.target.id === 'jc' || e.target.id === 'jn')) A.join(); });
render();
