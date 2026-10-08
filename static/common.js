// Shared helpers for the TV and phone pages
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const params = new URLSearchParams(location.search);
const BASE = location.origin;

function standings(S, opts = {}) {
  const ranked = S.players.slice().sort((a, b) => b.score - a.score);
  const top = ranked.length ? ranked[0].score : 0;
  return `<div class="board">${ranked.map((p, k) => `<div class="score ${p.score === top && top > 0 ? 'lead' : ''}">
    <span class="rk">${k + 1}</span><span class="nm">${esc(p.name)}</span>
    <span class="gain">${opts.gains && p.gain ? '+' + p.gain : ''}</span><span class="pts">${p.score}</span></div>`).join('')}</div>`;
}

function people(S, mode) {
  // mode: 'lobby' | 'progress'
  return `<div class="people">${S.players.filter(p => mode === 'lobby' || p.playing && !(S.mode === 'dasher' && p.dasher)).map(p => {
    let cls = p.connected ? '' : 'away';
    if (mode === 'progress') cls += p.waiting ? ' waiting' : ' done';
    return `<span class="person ${cls}">${p.vip ? '<span class="star" title="Runs the game">★</span>' : ''}${esc(p.name)}</span>`;
  }).join('')}</div>`;
}

function revealCards(S) {
  return `<ol class="defs ${S.defs.length > 4 ? 'two' : ''}">${S.defs.map((text, k) => {
    const c = S.cards[k];
    if (!c) return `<li class="def hidden"><span class="n">${k + 1}</span><span class="t">${esc(text)}</span></li>`;
    const tag = c.real ? `<span class="chip real">Real definition</span>` : `<span class="chip fake">Bluff by ${esc(c.by)}</span>`;
    const voters = c.voters.length ? `<span>${c.real ? 'found by' : 'fooled'}</span>${c.voters.map(v => `<span class="chip">${esc(v)}</span>`).join('')}` : '<span>no votes</span>';
    return `<li class="def pop ${c.real ? 'real' : ''}"><span class="n">${k + 1}</span><span class="t">${esc(text)}<span class="tag">${tag}${voters}</span></span></li>`;
  }).join('')}</ol>`;
}

const RULES = '2 points for finding the real definition. 1 point for every player your bluff fools.';
