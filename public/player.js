const socket = io();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TOKEN_KEY = 'quiz-token';
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} };

let state = null;
let stageKey = '';
let deadlineLocal = 0;
let timerHandle = null;
let lastText = { index: -1, value: '' }; // 記述式で取り消したとき、入力欄に前の回答を残しておく

function showLogin() {
  $('login').classList.remove('hidden');
  $('game').classList.add('hidden');
}

function join(payload) {
  socket.emit('player:join', payload, (res) => {
    if (res.error) {
      setToken(null);
      $('loginError').textContent = res.error;
      showLogin();
      return;
    }
    setToken(res.token);
    $('login').classList.add('hidden');
    $('game').classList.remove('hidden');
  });
}

$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  $('loginError').textContent = '';
  join({ name: $('nameInput').value });
});

socket.on('connect', () => {
  const token = getToken();
  if (token) join({ token });
  else showLogin();
});

socket.on('kicked', () => {
  setToken(null);
  state = null;
  stageKey = '';
  $('loginError').textContent = '出題者によって退出、またはリセットされました。再度参加してください。';
  showLogin();
});

socket.on('state', (s) => {
  state = s;
  if (s.me) {
    $('myName').textContent = s.me.name;
    $('myScore').textContent = s.me.score;
  }
  renderRanking();
  renderStage();
});

function renderRanking() {
  const myName = state.me?.name;
  $('ranking').innerHTML = state.ranking
    .map((r, i) => `<tr class="${r.name === myName ? 'me' : ''} ${r.connected ? '' : 'offline'}">
      <td>${i + 1}</td><td>${esc(r.name)}${r.connected ? '' : '（離脱中）'}</td><td class="num">${r.score} 点</td></tr>`)
    .join('');
}

function renderStage() {
  const s = state;
  const b = s.buzz;
  const key = [s.phase, s.index, s.myAnswer ? 'a' : '-', s.question?.answer != null ? 'r' : '-',
    b ? `${b.my}:${b.queue.map((x) => x.name).join(',')}:${b.wrong.length}` : ''].join('|');
  const stage = $('stage');

  // 回答数だけの変化では画面を作り直さない（入力中のテキストを消さないため）
  if (key === stageKey) {
    const c = stage.querySelector('[data-answered]');
    if (c) c.textContent = s.answeredCount;
    return;
  }
  stageKey = key;
  clearInterval(timerHandle);

  if (s.phase === 'lobby') {
    stage.innerHTML = `<h2>待機中</h2><p>出題者がクイズを開始するまでお待ちください。</p>`;
    return;
  }
  if (s.phase === 'finished') {
    const top = s.ranking[0];
    stage.innerHTML = `<h2>🏆 クイズ大会終了！</h2>
      ${top ? `<p class="result ok">優勝：${esc(top.name)}（${top.score} 点）</p>` : ''}
      <p>あなたの得点：<strong>${s.me?.score ?? 0} 点</strong></p>`;
    return;
  }

  const q = s.question;
  if (q.type === 'buzzer') return renderBuzzer(stage, s);
  const revealed = q.answer != null;
  const my = s.myAnswer;
  let html = `<div class="row"><div class="grow muted">第 ${s.index + 1} 問 / 全 ${s.total} 問　（${q.points} 点）</div>
    <div class="timer" id="timer"></div></div>
    <div class="question-text">${esc(q.text)}</div>${imageHtml(q)}`;

  if (q.type === 'choice') {
    html += `<div class="choices">${q.choices
      .map((c, i) => {
        const cls = ['choice'];
        if (my && my.answer === i) cls.push('selected');
        if (revealed) cls.push(i === q.answer ? 'correct' : 'dim');
        const disabled = s.phase !== 'question' || my ? 'disabled' : '';
        return `<button class="${cls.join(' ')}" data-i="${i}" ${disabled}>${esc(c)}</button>`;
      })
      .join('')}</div>`;
  } else if (!my && s.phase === 'question') {
    html += `<form id="textForm" class="row"><input id="textAnswer" class="grow" placeholder="回答を入力" maxlength="200" autocomplete="off" value="${lastText.index === s.index ? esc(lastText.value) : ''}"><button>送信</button></form>`;
  } else if (my) {
    html += `<p>あなたの回答：<strong>${esc(my.answer)}</strong></p>`;
  }
  if (revealed && q.type === 'text') html += `<p>正解：<strong>${esc(q.answer.split(/[,、]/)[0])}</strong></p>`;

  html += `<p class="error" id="answerError"></p>`;
  if (revealed) {
    if (!my) html += `<div class="result ng">未回答</div>`;
    else html += my.correct ? `<div class="result ok">⭕ 正解！ +${q.points}</div>` : `<div class="result ng">❌ 不正解</div>`;
  } else if (s.phase === 'closed') {
    html += `<p class="muted">回答を締め切りました。正解発表を待っています…</p>`;
  } else if (my) {
    html += `<p class="muted">回答しました！ 他の人を待っています…（回答数 <span data-answered>${s.answeredCount}</span>）</p>
      <button class="sub" id="cancelBtn">↩ 回答を取り消して選び直す</button>`;
  } else {
    html += `<p class="muted">回答数 <span data-answered>${s.answeredCount}</span></p>`;
  }
  stage.innerHTML = html;

  stage.querySelectorAll('.choice:not([disabled])').forEach((b) =>
    b.addEventListener('click', () => submit(Number(b.dataset.i))));
  const form = $('textForm');
  if (form) {
    $('textAnswer').focus();
    form.addEventListener('submit', (e) => { e.preventDefault(); lastText = { index: s.index, value: $('textAnswer').value }; submit(lastText.value); });
  }
  const cancelBtn = $('cancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    cancelBtn.disabled = true;
    socket.emit('player:cancel', null, (res) => {
      if (res.error) { $('answerError').textContent = res.error; cancelBtn.disabled = false; }
    });
  });

  startTimer(s);
}

// 画像はタップで別タブに原寸表示
const imageHtml = (q) =>
  q.image ? `<a href="${esc(q.image)}" target="_blank" rel="noopener"><img class="qimg" src="${esc(q.image)}" alt="問題の画像"></a>` : '';

function startTimer(s) {
  if (s.phase !== 'question' || s.remainingMs == null) return;
  deadlineLocal = Date.now() + s.remainingMs;
  const tick = () => {
    const sec = Math.max(0, Math.ceil((deadlineLocal - Date.now()) / 1000));
    const t = $('timer');
    if (!t) return clearInterval(timerHandle);
    t.textContent = sec;
    t.classList.toggle('low', sec <= 5);
  };
  tick();
  timerHandle = setInterval(tick, 200);
}

// ---------- 早押し ----------
function renderBuzzer(stage, s) {
  const q = s.question;
  const b = s.buzz;
  const revealed = s.phase === 'revealed';
  let html = `<div class="row"><div class="grow muted">第 ${s.index + 1} 問 / 全 ${s.total} 問　早押し（正解 +${q.points}${q.penalty ? ` / 誤答 -${q.penalty}` : ''}）</div>
    <div class="timer" id="timer"></div></div>
    <div class="question-text">${q.text != null ? esc(q.text) : '<span class="muted">🎙️ 出題者が問題を読み上げます</span>'}</div>${imageHtml(q)}`;

  if (s.phase === 'question' && b.my === 'none') {
    html += `<button class="buzz" id="buzzBtn">早押し！</button><p class="muted" style="text-align:center">スペースキーでも押せます</p>`;
  } else if (b.my === 'answering' && !revealed) {
    html += `<div class="result ok">🔔 回答権獲得！ 口頭で答えてください</div>`;
  } else if (b.my === 'queued' && !revealed) {
    html += `<div class="result">${b.myPosition} 番目に押しました。順番待ち…</div>`;
  } else if (b.my === 'wrong' && !revealed) {
    html += `<div class="result ng">❌ 誤答（この問題の回答権はありません）</div>`;
  }

  if (revealed) {
    html += `<p>正解：<strong>${esc(q.answer)}</strong></p>`;
    if (b.my === 'winner') html += `<div class="result ok">⭕ 正解！ +${q.points}</div>`;
    else if (b.winner) html += `<div class="result">⭕ ${esc(b.winner)} さんが正解！</div>`;
    else html += `<div class="result">正解者なし</div>`;
  } else if (s.phase === 'closed') {
    html += `<p class="muted">早押しを締め切りました。</p>`;
  }

  if (b.queue.length && !revealed) {
    html += `<h2 style="margin-top:12px">押した順</h2><ol>${b.queue
      .map((x, i) => `<li>${esc(x.name)} <span class="muted">${(x.elapsedMs / 1000).toFixed(2)}s</span>${i === 0 ? ' <span class="badge ok">回答中</span>' : ''}</li>`)
      .join('')}</ol>`;
  }
  if (b.wrong.length) html += `<p class="muted">誤答：${b.wrong.map(esc).join('、')}</p>`;
  html += `<p class="error" id="answerError"></p>`;
  stage.innerHTML = html;

  const btn = $('buzzBtn');
  if (btn) btn.addEventListener('click', buzz);
  startTimer(s);
}

function buzz() {
  const btn = $('buzzBtn');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  socket.emit('player:buzz', null, (res) => {
    if (res.error) {
      btn.disabled = false;
      $('answerError').textContent = res.error;
    } else beep(res.position === 1 ? 880 : 520);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || e.target.matches('input, textarea')) return;
  if ($('buzzBtn')) { e.preventDefault(); buzz(); }
});

let audioCtx = null;
function beep(freq) {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.25, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.4);
  } catch {}
}

function submit(answer) {
  socket.emit('player:answer', answer, (res) => {
    if (res.error) $('answerError').textContent = res.error;
  });
}
