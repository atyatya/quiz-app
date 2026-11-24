const socket = io();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PW_KEY = 'quiz-host-pw';
const PHASES = { lobby: '待機中', question: '回答受付中', closed: '締め切り', revealed: '正解発表済み', finished: '大会終了' };

let state = null;
let draft = [];      // 編集中の問題リスト
let dirty = false;   // 未保存の編集があるか
let timerHandle = null;
let hostPw = '';     // 画像アップロード時の認証用

// ---------- ログイン ----------
function login(pw) {
  socket.emit('host:login', pw, (res) => {
    if (res.error) {
      $('loginError').textContent = res.error;
      try { sessionStorage.removeItem(PW_KEY); } catch {}
      return;
    }
    hostPw = pw;
    try { sessionStorage.setItem(PW_KEY, pw); } catch {}
    $('login').classList.add('hidden');
    $('main').classList.remove('hidden');
  });
}
$('loginForm').addEventListener('submit', (e) => { e.preventDefault(); login($('pwInput').value); });
socket.on('connect', () => {
  let pw = null;
  try { pw = sessionStorage.getItem(PW_KEY); } catch {}
  if (pw) login(pw);
});
socket.on('host:kicked', () => {
  alert('別の画面で出題者がログインしたため、この画面はログアウトしました。');
  try { sessionStorage.removeItem(PW_KEY); } catch {}
  location.reload();
});

const emit = (event, payload) =>
  new Promise((resolve) => socket.emit(event, payload, (res) => {
    if (res?.error) alert(res.error);
    resolve(res);
  }));

// ---------- 進行ボタン ----------
$('btnNext').addEventListener('click', () => {
  if (dirty && !confirm('問題リストに未保存の変更があります。保存せずに出題しますか？')) return;
  emit('host:start', state.index + 1);
});
$('btnClose').addEventListener('click', () => emit('host:close'));
$('btnReveal').addEventListener('click', () => emit('host:reveal'));
$('btnRanking').addEventListener('click', () => emit('host:showRanking', !state.showRanking));
$('btnFinish').addEventListener('click', () => confirm('大会を終了して最終結果を表示しますか？') && emit('host:finish'));
$('btnReset').addEventListener('click', () => {
  const keep = confirm('参加者を残したまま得点だけリセットしますか？\n（キャンセルを押すと次の確認に進みます）');
  if (keep) return emit('host:reset', { keepPlayers: true });
  if (confirm('参加者も全員退出させてリセットしますか？')) emit('host:reset', { keepPlayers: false });
});

socket.on('hostState', (s) => {
  state = s;
  if (!dirty) draft = structuredClone(s.questions);
  render();
});

function render() {
  const s = state;
  $('phaseLabel').textContent = PHASES[s.phase];
  $('progressLabel').textContent = s.index >= 0 ? `（第 ${s.index + 1} 問 / 全 ${s.total} 問）` : `（全 ${s.total} 問）`;

  const inQ = s.phase === 'question' || s.phase === 'closed';
  $('btnNext').disabled = inQ || s.index + 1 >= s.total;
  $('btnNext').textContent = s.index < 0 ? '第1問を出題' : '次の問題を出題';
  $('btnClose').disabled = s.phase !== 'question';
  $('btnReveal').disabled = !inQ;
  $('btnFinish').disabled = s.phase === 'finished';
  $('btnRanking').textContent = s.showRanking ? '📺 問題画面に戻す' : '📊 ランキングを映す';
  $('btnRanking').disabled = s.phase === 'finished';

  renderTimer();
  renderCurrent();
  renderAnswers();
  renderPlayers();
  renderQuestions();
}

function renderTimer() {
  clearInterval(timerHandle);
  const t = $('timer');
  t.textContent = '';
  if (state.phase !== 'question' || state.remainingMs == null) return;
  const end = Date.now() + state.remainingMs;
  const tick = () => {
    const sec = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    t.textContent = `残り ${sec} 秒`;
    t.classList.toggle('low', sec <= 5);
  };
  tick();
  timerHandle = setInterval(tick, 200);
}

function answerLabel(q, a) {
  return q.type === 'choice' ? `${a + 1}. ${q.choices[a] ?? ''}` : a;
}

function renderCurrent() {
  const q = state.currentQuestion;
  if (!q || state.index < 0 || state.phase === 'lobby') {
    $('current').innerHTML = '<span class="muted">まだ出題していません</span>';
    return;
  }
  const ans = q.type === 'choice' ? answerLabel(q, q.answer) : q.answer;
  const typeLabel = { choice: '選択式', text: '記述式', buzzer: '早押し' }[q.type];
  $('current').innerHTML = `<span class="badge">${typeLabel}</span>
    ${q.type === 'buzzer' && !q.showText ? '<span class="muted">（回答者には非表示・読み上げてください）</span>' : ''}
    <div class="question-text" style="font-size:1.2rem">${esc(q.text)}</div>
    ${q.image ? `<img class="qimg" src="${esc(q.image)}" alt="">` : ''}
    ${q.type === 'choice' ? `<ol>${q.choices.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>` : ''}
    <p>正解：<strong>${esc(ans)}</strong>　配点 ${q.points} 点${q.type === 'buzzer' ? ` / 誤答 -${q.penalty} 点` : ''} / 制限時間 ${q.timeLimit ? q.timeLimit + ' 秒' : 'なし'}</p>`;
}

function renderAnswers() {
  const q = state.currentQuestion;
  const isBuzzer = q?.type === 'buzzer' && state.phase !== 'lobby' && state.phase !== 'finished';
  $('normalPanel').classList.toggle('hidden', isBuzzer);
  $('buzzPanel').classList.toggle('hidden', !isBuzzer);
  if (isBuzzer) return renderBuzz();
  const online = state.players.filter((p) => p.connected).length;
  $('answerCount').textContent = `（${state.answers.length} / ${online} 人）`
    + (state.phase === 'question' && state.allAnswered ? '　✅ 全員回答済み（締め切りか正解発表へ）' : '');
  if (!q || state.phase === 'lobby') { $('answers').innerHTML = ''; return; }
  $('answers').innerHTML = state.answers
    .map((a) => `<tr>
      <td>${esc(a.name)}</td>
      <td>${esc(answerLabel(q, a.answer))}</td>
      <td class="num">${(a.elapsedMs / 1000).toFixed(1)}s</td>
      <td><button class="small ${a.correct ? 'ok' : 'danger'}" data-judge="${a.token}" data-correct="${a.correct ? 0 : 1}">${a.correct ? '⭕ 正解' : '❌ 不正解'}</button></td>
    </tr>`)
    .join('');
  $('answers').querySelectorAll('[data-judge]').forEach((b) =>
    b.addEventListener('click', () => emit('host:judge', { token: b.dataset.judge, correct: b.dataset.correct === '1' })));
}

// ---------- 早押し ----------
function renderBuzz() {
  const b = state.buzz;
  const judging = state.phase === 'question' || state.phase === 'closed';
  $('answerCount').textContent = `（押した人 ${b.queue.length} 人）`;
  if (state.phase === 'revealed') {
    $('buzzQueue').innerHTML = b.winner
      ? `<div class="result ok">⭕ ${esc(b.winner)} さんが正解</div>`
      : '<div class="result">正解者なし</div>';
  } else {
    $('buzzQueue').innerHTML = b.queue.length
      ? b.queue.map((x, i) => `<div class="buzz-row ${i === 0 ? 'first' : ''}">
          <span>${i + 1}.</span><span class="grow">${esc(x.name)}</span>
          <span class="muted">${(x.elapsedMs / 1000).toFixed(2)}s</span>
          ${i === 0 ? '<span class="badge ok">回答権</span>' : ''}</div>`).join('')
      : `<p class="muted">${state.phase === 'question' ? 'ボタンが押されるのを待っています…' : '締め切りました'}</p>`;
  }
  $('buzzWrong').textContent = b.wrong.length ? `誤答：${b.wrong.join('、')}` : '';
  const can = judging && b.queue.length > 0;
  $('btnBuzzOk').disabled = !can;
  $('btnBuzzNg').disabled = !can;
  $('btnBuzzReset').disabled = !can;
}

$('btnBuzzOk').addEventListener('click', () => emit('host:buzzJudge', { correct: true }));
$('btnBuzzNg').addEventListener('click', () => emit('host:buzzJudge', { correct: false }));
$('btnBuzzReset').addEventListener('click', () => emit('host:buzzReset'));

// 誰かが押したら音を鳴らす（1番目は高い音）
let audioCtx = null;
socket.on('buzzed', ({ position }) => {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = position === 1 ? 880 : 520;
    g.gain.setValueAtTime(0.25, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.4);
  } catch {}
});

function renderPlayers() {
  $('playerCount').textContent = `（${state.players.length} 人）`;
  $('players').innerHTML = state.players
    .map((p, i) => `<tr class="${p.connected ? '' : 'offline'}">
      <td>${i + 1}</td><td>${esc(p.name)}${p.connected ? '' : '（離脱中）'}</td>
      <td class="num">${p.score} 点</td>
      <td class="num">
        <button class="sub small" data-adj="${p.token}" data-d="1">+1</button>
        <button class="sub small" data-adj="${p.token}" data-d="-1">-1</button>
        <button class="danger small" data-kick="${p.token}">退出</button>
      </td></tr>`)
    .join('') || '<tr><td class="muted">まだ参加者がいません</td></tr>';
  $('players').querySelectorAll('[data-adj]').forEach((b) =>
    b.addEventListener('click', () => emit('host:adjustScore', { token: b.dataset.adj, delta: Number(b.dataset.d) })));
  $('players').querySelectorAll('[data-kick]').forEach((b) =>
    b.addEventListener('click', () => confirm('この参加者を退出させますか？') && emit('host:kick', b.dataset.kick)));
}

// ---------- 問題エディタ ----------
function renderQuestions(force = false) {
  // 入力中の要素があれば再描画しない（フォーカスが外れるのを防ぐ）
  const active = document.activeElement;
  if (!force && dirty && active && $('qlist').contains(active) && active.matches('input, textarea, select')) return;

  const inQ = state.phase === 'question' || state.phase === 'closed';
  $('qlist').innerHTML = draft
    .map((q, qi) => `<div class="qitem ${qi === state.index && state.phase !== 'lobby' ? 'current' : ''}" data-q="${qi}">
      <div class="row">
        <strong class="grow">Q${qi + 1}（${{ choice: '選択式', text: '記述式', buzzer: '早押し' }[q.type]}）</strong>
        <button class="small" data-start="${qi}" ${inQ || dirty ? 'disabled' : ''} title="${dirty ? '保存してから出題できます' : ''}">この問題を出題</button>
        <button class="sub small" data-move="-1" ${qi === 0 ? 'disabled' : ''}>↑</button>
        <button class="sub small" data-move="1" ${qi === draft.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="danger small" data-del>削除</button>
      </div>
      <label class="label">問題文</label>
      <textarea data-f="text" rows="2">${esc(q.text)}</textarea>
      <label class="label">画像（任意・PNG / JPEG / GIF / WebP）</label>
      ${q.image
        ? `<div class="row"><img class="thumb" src="${esc(q.image)}" alt=""><button class="sub small" data-delimage>画像を外す</button></div>`
        : `<div class="row"><input type="file" accept="image/png,image/jpeg,image/gif,image/webp" data-image style="width:auto"><span class="muted" data-upstatus></span></div>`}
      ${q.type === 'choice'
        ? `<label class="label">選択肢（◉ が正解）</label>
           ${q.choices.map((c, ci) => `<div class="choice-row">
              <input type="radio" name="ans${qi}" data-ans="${ci}" ${q.answer === ci ? 'checked' : ''}>
              <input data-choice="${ci}" value="${esc(c)}" placeholder="選択肢 ${ci + 1}">
              <button class="sub small" data-delchoice="${ci}" ${q.choices.length <= 2 ? 'disabled' : ''}>×</button>
            </div>`).join('')}
           ${q.choices.length < 6 ? '<button class="sub small" data-addchoice style="margin-top:6px">＋ 選択肢</button>' : ''}`
        : q.type === 'buzzer'
        ? `<label class="label">正解（出題者の判定用）</label>
           <input data-f="answer" value="${esc(q.answer)}">
           <label class="row label" style="cursor:pointer"><input type="checkbox" data-f="showText" style="width:auto" ${q.showText ? 'checked' : ''}> 問題文を回答者の画面に表示する（オフ＝読み上げ式）</label>`
        : `<label class="label">正解（表記ゆれはカンマ区切りで複数指定）</label>
           <input data-f="answer" value="${esc(q.answer)}">`}
      <div class="row">
        <div class="grow"><label class="label">配点</label><input type="number" min="0" data-f="points" value="${q.points}"></div>
        ${q.type === 'buzzer' ? `<div class="grow"><label class="label">誤答時の減点</label><input type="number" min="0" data-f="penalty" value="${q.penalty}"></div>` : ''}
        <div class="grow"><label class="label">制限時間（秒・0で無制限）</label><input type="number" min="0" data-f="timeLimit" value="${q.timeLimit}"></div>
      </div>
    </div>`)
    .join('') || '<p class="muted">問題がありません。右上のボタンから追加してください。</p>';
  $('btnSave').disabled = !dirty || inQ;
  $('btnSave').textContent = dirty ? '保存（未保存）' : '保存済み';
}

function markDirty() {
  dirty = true;
  $('btnSave').disabled = state.phase === 'question' || state.phase === 'closed';
  $('btnSave').textContent = '保存（未保存）';
}

$('qlist').addEventListener('input', (e) => {
  const item = e.target.closest('[data-q]');
  if (!item) return;
  const q = draft[Number(item.dataset.q)];
  const t = e.target;
  if (t.hasAttribute('data-image')) return; // change イベントで処理
  if (t.dataset.f) q[t.dataset.f] = t.type === 'number' ? Number(t.value) : t.type === 'checkbox' ? t.checked : t.value;
  else if (t.dataset.choice != null) q.choices[Number(t.dataset.choice)] = t.value;
  else if (t.dataset.ans != null) q.answer = Number(t.dataset.ans);
  markDirty();
});

$('qlist').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  const item = e.target.closest('[data-q]');
  if (!b || !item) return;
  const qi = Number(item.dataset.q);
  const q = draft[qi];
  if (b.dataset.start != null) return emit('host:start', qi);
  if (b.dataset.move) {
    const to = qi + Number(b.dataset.move);
    [draft[qi], draft[to]] = [draft[to], draft[qi]];
  } else if (b.hasAttribute('data-del')) {
    if (!confirm(`Q${qi + 1} を削除しますか？`)) return;
    draft.splice(qi, 1);
  } else if (b.hasAttribute('data-delimage')) {
    q.image = null;
  } else if (b.hasAttribute('data-addchoice')) {
    q.choices.push('');
  } else if (b.dataset.delchoice != null) {
    const ci = Number(b.dataset.delchoice);
    q.choices.splice(ci, 1);
    if (q.answer >= q.choices.length || q.answer === ci) q.answer = 0;
    else if (q.answer > ci) q.answer--;
  } else return;
  markDirty();
  renderQuestions(true);
});

// ---------- 画像アップロード ----------
$('qlist').addEventListener('change', async (e) => {
  const input = e.target;
  if (!input.hasAttribute('data-image') || !input.files[0]) return;
  const item = input.closest('[data-q]');
  const q = draft[Number(item.dataset.q)];
  const status = item.querySelector('[data-upstatus]');
  input.disabled = true;
  status.textContent = 'アップロード中…';
  try {
    const blob = await shrinkImage(input.files[0]);
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': blob.type, 'X-Host-Password': hostPw },
      body: blob,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'アップロードに失敗しました');
    q.image = data.url;
    markDirty();
    renderQuestions(true);
  } catch (err) {
    status.textContent = err.message;
    input.disabled = false;
  }
});

// スマホで撮った大きな写真は、回答者の読み込みが重くならないよう長辺1600pxに縮小する
// （GIF はアニメーションが消えるのでそのまま）
const MAX_SIDE = 1600;
async function shrinkImage(file) {
  if (file.type === 'image/gif') return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  // PNG は透過を保つため PNG のまま、それ以外は JPEG
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b || file), type, 0.85));
}

$('btnAddChoice').addEventListener('click', () => {
  draft.push({ text: '', type: 'choice', choices: ['', '', '', ''], answer: 0, points: 10, timeLimit: 20 });
  markDirty(); renderQuestions(true);
});
$('btnAddText').addEventListener('click', () => {
  draft.push({ text: '', type: 'text', answer: '', points: 10, timeLimit: 30 });
  markDirty(); renderQuestions(true);
});
$('btnAddBuzzer').addEventListener('click', () => {
  draft.push({ text: '', type: 'buzzer', answer: '', points: 20, penalty: 0, timeLimit: 0, showText: true });
  markDirty(); renderQuestions(true);
});
$('btnSave').addEventListener('click', async () => {
  $('editError').textContent = '';
  const bad = draft.findIndex((q) => !q.text.trim() || (q.type === 'choice' ? q.choices.filter((c) => c.trim()).length < 2 || !q.choices[q.answer]?.trim() : !q.answer.trim()));
  if (bad >= 0) {
    $('editError').textContent = `Q${bad + 1}：問題文・正解・選択肢（2つ以上）を入力してください`;
    return;
  }
  const res = await emit('host:saveQuestions', draft);
  if (res?.ok) { dirty = false; render(); }
});

window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });
