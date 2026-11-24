const socket = io();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sec = (ms) => (ms / 1000).toFixed(2) + 's';

let joinInfo = null;
let lastKey = '';
let timerHandle = null;

const loadJoinInfo = () =>
  fetch('/api/join-info').then((r) => r.json()).then((info) => { joinInfo = info; lastKey = ''; if (state) render(); });
loadJoinInfo();
// インターネット公開のURLが決まったらQRコードを作り直す
socket.on('joinInfoChanged', loadJoinInfo);

let state = null;
socket.on('connect', () => { $('conn').textContent = ''; socket.emit('screen:join'); });
socket.on('disconnect', () => { $('conn').textContent = '● サーバーとの接続が切れています'; });
socket.on('screenState', (s) => { state = s; render(); });

$('fsBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});
document.addEventListener('fullscreenchange', () => { $('fsBtn').style.display = document.fullscreenElement ? 'none' : ''; });
document.addEventListener('dblclick', () => $('fsBtn').click());

function render() {
  const s = state;
  $('progress').textContent = s.index >= 0 && s.phase !== 'lobby' && s.phase !== 'finished' ? `第 ${s.index + 1} 問 / 全 ${s.total} 問` : '';

  // 同じ画面のまま回答数だけ変わった場合はアニメーションをやり直さないよう、変化した部分だけ更新
  const key = JSON.stringify([s.phase, s.index, s.showRanking, s.question, s.buzz, s.stats, s.phase === 'lobby' || s.showRanking || s.phase === 'finished' ? s.ranking : null]);
  if (key === lastKey) {
    const c = $('answered');
    if (c) c.textContent = `${s.answeredCount} / ${s.onlineCount}`;
    return;
  }
  lastKey = key;

  const main = $('main');
  main.className = '';
  void main.offsetWidth; // アニメーションを再生し直すためのリフロー
  main.className = 'fade';

  if (s.phase === 'finished') main.innerHTML = rankingView('🏆 最終結果', s.ranking);
  else if (s.showRanking) main.innerHTML = rankingView('📊 現在のランキング', s.ranking);
  else if (s.phase === 'lobby') main.innerHTML = lobbyView(s);
  else if (s.question.type === 'buzzer') main.innerHTML = buzzerView(s);
  else main.innerHTML = questionView(s);

  // 選択肢の人数バーを、描画後に伸ばす
  requestAnimationFrame(() => main.querySelectorAll('.bar[data-w]').forEach((b) => (b.style.width = b.dataset.w)));
  startTimer(s);
}

function startTimer(s) {
  clearInterval(timerHandle);
  const t = $('timer');
  t.textContent = '';
  t.classList.remove('low');
  if (s.phase !== 'question' || s.remainingMs == null || s.showRanking) return;
  const end = Date.now() + s.remainingMs;
  const tick = () => {
    const r = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    t.textContent = r;
    t.classList.toggle('low', r <= 5);
  };
  tick();
  timerHandle = setInterval(tick, 200);
}

function lobbyView(s) {
  const players = s.ranking.filter((p) => p.connected);
  return `<div class="lobby">
    <div class="qr">${joinInfo ? joinInfo.qrSvg : ''}</div>
    <div>
      <h1>参加者募集中！</h1>
      <p style="font-size:clamp(16px,2vw,44px);color:var(--muted);margin:0">スマホでQRコードを読み取って参加してください</p>
      <div class="url">${joinInfo ? esc(joinInfo.url) : ''}</div>
      <p style="font-size:clamp(16px,2vw,44px);margin:0 0 1vh">参加者 <strong>${players.length}</strong> 人</p>
      <div class="names">${players.map((p) => `<span class="chip">${esc(p.name)}</span>`).join('')}</div>
    </div>
  </div>`;
}

function questionView(s) {
  const q = s.question;
  const revealed = s.phase === 'revealed';
  const st = s.stats;
  let html = `<div><span class="tag">${q.type === 'choice' ? '選択式' : '記述式'}　${q.points} 点</span></div>
    <div class="qtext ${q.type === 'text' && !revealed && !q.image ? 'center' : ''}">${esc(q.text)}</div>`;

  let body = '';
  if (q.type === 'choice') {
    const max = st ? Math.max(1, ...st.choiceCounts) : 1;
    body += `<div class="choices">${q.choices.map((c, i) => {
      const cls = ['choice'];
      if (revealed) cls.push(i === q.answer ? 'correct' : 'dim');
      const count = st ? st.choiceCounts[i] : null;
      return `<div class="${cls.join(' ')}" style="background:var(--c${i})">
        ${st ? `<div class="bar" style="width:0" data-w="${(count / max) * 100}%"></div>` : ''}
        <span class="no">${i + 1}</span><span class="label">${esc(c)}</span>
        ${st ? `<span class="count">${count} 人</span>` : ''}
      </div>`;
    }).join('')}</div>`;
  } else if (revealed) {
    body += `<div class="answer-box"><div class="lbl">正解</div><div class="ans">${esc(q.answer.split(/[,、]/)[0].trim())}</div></div>`;
  }
  html += qarea(q, body);

  if (revealed && st) {
    html += `<div class="banner">⭕ 正解者 ${st.correct.length} 人 / 回答 ${st.answered} 人</div>
      <div class="names">${st.correct.slice(0, 15).map((c, i) =>
        `<span class="chip ${i === 0 ? 'first' : ''}">${i === 0 ? '⚡ ' : ''}${esc(c.name)} <small>${sec(c.elapsedMs)}</small></span>`).join('')}
        ${st.correct.length > 15 ? `<span class="chip">ほか ${st.correct.length - 15} 人</span>` : ''}</div>`;
  } else {
    html += `<div class="footer"><span>${s.phase === 'closed' ? '<strong style="color:var(--accent)">回答締め切り！</strong>' : '回答受付中…'}</span>
      <span>回答数 <strong id="answered">${s.answeredCount} / ${s.onlineCount}</strong></span></div>`;
  }
  return html;
}

function buzzerView(s) {
  const q = s.question;
  const b = s.buzz;
  const revealed = s.phase === 'revealed';
  let html = `<div><span class="tag">⚡ 早押し　+${q.points} 点${q.penalty ? `　誤答 -${q.penalty}` : ''}</span></div>
    <div class="qtext">${q.text != null ? esc(q.text) : '🎙️ <span style="color:var(--muted)">問題を読み上げます…</span>'}</div>`;

  if (revealed) {
    return html + qarea(q, `<div class="answer-box"><div class="lbl">正解</div><div class="ans">${esc(q.answer)}</div>
      <div class="banner">${b.winner ? `⭕ ${esc(b.winner)} さん 正解！` : '正解者なし'}</div></div>`);
  }
  let body = '';
  if (b.queue.length) {
    body += `<div class="buzz-list">${b.queue.slice(0, 5).map((x, i) =>
      `<div class="buzz-item ${i === 0 ? 'first' : ''}"><span>${i === 0 ? '🔔' : i + 1 + '.'}</span><span>${esc(x.name)}</span><span class="t">${sec(x.elapsedMs)}</span></div>`).join('')}</div>`;
  } else {
    body += `<div class="banner">${s.phase === 'closed' ? '締め切り' : 'ボタンを押して回答！'}</div>`;
  }
  html += qarea(q, body);
  if (b.wrong.length) html += `<div class="footer"><span>❌ 誤答：${b.wrong.map(esc).join('、')}</span></div>`;
  return html;
}

// 画像があれば左に画像、右に選択肢などを並べる。なければ従来どおり縦に並べる
function qarea(q, body) {
  if (!q.image) return body ? `<div class="qarea">${body}</div>` : '';
  return `<div class="qarea has-img">
    <div class="qimg"><img src="${esc(q.image)}" alt=""></div>
    ${body ? `<div class="qcontent">${body}</div>` : ''}
  </div>`;
}

function rankingView(title, ranking) {
  const top = ranking.slice(0, 10);
  // 同点は同順位にする
  let prev = null, pos = 0;
  const rows = top.map((r, i) => {
    if (r.score !== prev) { pos = i + 1; prev = r.score; }
    return `<div class="rank-row r${pos}" style="animation-delay:${(top.length - i) * 0.12}s">
      <span class="pos">${pos}位</span><span class="nm">${esc(r.name)}</span><span class="sc">${r.score} 点</span></div>`;
  });
  return `<div class="big-title">${title}</div><div class="ranking">${rows.join('') || '<p style="text-align:center">参加者がいません</p>'}</div>`;
}

// 早押しの効果音
let audioCtx = null;
document.addEventListener('click', () => { try { audioCtx ??= new AudioContext(); } catch {} }, { once: true });
socket.on('buzzed', ({ position }) => {
  if (!audioCtx) return; // ブラウザの自動再生制限のため、一度画面をクリックすると鳴るようになる
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.frequency.value = position === 1 ? 880 : 520;
  g.gain.setValueAtTime(0.3, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
  o.connect(g).connect(audioCtx.destination);
  o.start();
  o.stop(audioCtx.currentTime + 0.5);
});
