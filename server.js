// クイズ大会サーバー（出題者1人＋複数回答者）
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
// --online: Cloudflare のトンネルでインターネットに公開する
const ONLINE = process.argv.includes('--online');
// 公開時に推測されやすい既定パスワードのままにならないよう、未設定ならランダムに決める
const HOST_PASSWORD = process.env.HOST_PASSWORD || (ONLINE ? crypto.randomBytes(4).toString('hex') : 'admin');
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 200;
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

const lanIps = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
// 回答者の参加用URL（スクリーンのQRコード用）。PUBLIC_URL で上書き可
// （--online のときはトンネルのURLが決まった時点で置き換える）
let JOIN_URL = process.env.PUBLIC_URL || `http://${lanIps()[0] || 'localhost'}:${PORT}/`;

// ---------- 出題者パスワードの確認（総当たり対策つき） ----------
// トンネル経由の接続はすべて 127.0.0.1 から来るので、cloudflared が付ける元のIPを使う
const clientIp = (headers, addr = '') =>
  (/^(::1|127\.|::ffff:127\.)/.test(addr) && headers['cf-connecting-ip']) || addr;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const loginFailures = new Map(); // ip -> { count, last, until }

// 5回続けて間違えたら、そのIPからは1分間ログインできなくする。成功なら null、失敗ならエラーメッセージを返す
function checkHostPassword(ip, password) {
  const now = Date.now();
  const rec = loginFailures.get(ip);
  if (rec?.until > now) return 'ログインの失敗が続いたため、1分ほど待ってからお試しください';
  if (crypto.timingSafeEqual(sha(password), sha(HOST_PASSWORD))) {
    loginFailures.delete(ip);
    return null;
  }
  const r = rec && now - rec.last < 10 * 60 * 1000 ? rec : { count: 0 };
  r.count++;
  r.last = now;
  if (r.count >= 5) { r.until = now + 60 * 1000; r.count = 0; }
  loginFailures.set(ip, r);
  return 'パスワードが違います';
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/screen', (req, res) => res.sendFile(path.join(__dirname, 'public', 'screen.html')));
app.get('/api/join-info', async (req, res) => {
  const qrSvg = await QRCode.toString(JOIN_URL, { type: 'svg', margin: 1 });
  res.json({ url: JOIN_URL, qrSvg });
});

// ---------- 問題画像 ----------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// SVG はスクリプトを含められるので受け付けない
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const IMAGE_PATH_RE = /^\/uploads\/[a-f0-9]{32}\.(png|jpg|gif|webp)$/;

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1d', immutable: true }));
app.post('/api/upload', express.raw({ type: Object.keys(IMAGE_TYPES), limit: '10mb' }), (req, res) => {
  const authError = checkHostPassword(clientIp(req.headers, req.socket.remoteAddress), req.get('x-host-password'));
  if (authError) return res.status(403).json({ error: authError });
  const ext = IMAGE_TYPES[req.get('content-type')];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'PNG / JPEG / GIF / WebP の画像を選んでください' });
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
  res.json({ url: `/uploads/${name}` });
});
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: '画像が大きすぎます（10MBまで）' });
  next(err);
});

// ---------- 状態 ----------
let questions = loadQuestions();
const players = new Map(); // token -> { token, name, score, socketId, connected }
let hostSocketId = null;

const game = {
  phase: 'lobby', // lobby | question | closed | revealed | finished
  index: -1,
  startedAt: 0,
  deadline: 0,
  answers: new Map(), // token -> { answer, elapsedMs, correct }
  // 早押し用
  buzzQueue: [], // 押した順 [{ token, elapsedMs }]。先頭が回答権を持つ
  buzzWrong: new Set(), // 誤答して回答権を失った token
  winner: null, // 正解した token
  showRanking: false, // スクリーンにランキングを表示するか
  timer: null,
};

function loadQuestions() {
  try {
    return JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  } catch {
    return [
      { text: '日本で一番高い山は？', type: 'choice', choices: ['富士山', '北岳', '奥穂高岳', '槍ヶ岳'], answer: 0, points: 10, timeLimit: 20 },
      { text: '1年は何日？（うるう年を除く）', type: 'text', answer: '365, 365日', points: 10, timeLimit: 30 },
      { text: '「吾輩は猫である」の作者は？', type: 'buzzer', answer: '夏目漱石', points: 20, penalty: 5, timeLimit: 0, showText: true },
    ];
  }
}

function saveQuestions() {
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2), 'utf8');
}

function sanitizeQuestion(q) {
  const image = IMAGE_PATH_RE.test(q.image) ? q.image : null;
  return { ...sanitizeQuestionBody(q), image };
}

function sanitizeQuestionBody(q) {
  const points = Math.max(0, Math.round(Number(q.points) || 10));
  const timeLimit = Math.max(0, Math.round(Number(q.timeLimit) || 0));
  const text = String(q.text || '').slice(0, 1000);
  if (q.type === 'choice') {
    // 空の選択肢を除き、正解のインデックスを詰めた後の位置に合わせる
    const raw = (Array.isArray(q.choices) ? q.choices : []).map((c) => String(c).slice(0, 200));
    const choices = [];
    let answer = 0;
    raw.forEach((c, i) => {
      if (!c.trim()) return;
      if (i === Number(q.answer)) answer = choices.length;
      choices.push(c);
    });
    return { text, type: 'choice', choices, answer, points, timeLimit };
  }
  if (q.type === 'buzzer') {
    const penalty = Math.max(0, Math.round(Number(q.penalty) || 0));
    return { text, type: 'buzzer', answer: String(q.answer || '').slice(0, 500), points, penalty, timeLimit, showText: q.showText !== false };
  }
  return { text, type: 'text', answer: String(q.answer || '').slice(0, 500), points, timeLimit };
}

const normalize = (s) =>
  String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, '');

function autoJudge(q, answer) {
  if (q.type === 'choice') return answer === q.answer;
  const accepted = q.answer.split(/[,、]/).map(normalize).filter(Boolean);
  return accepted.includes(normalize(answer));
}

const currentQuestion = () => questions[game.index];
const nameOf = (token) => players.get(token)?.name ?? '?';

function buzzInfo(token) {
  const pos = token ? game.buzzQueue.findIndex((b) => b.token === token) : -1;
  let my = 'none'; // none | answering | queued | wrong | winner
  if (token && token === game.winner) my = 'winner';
  else if (game.buzzWrong.has(token)) my = 'wrong';
  else if (pos === 0) my = 'answering';
  else if (pos > 0) my = 'queued';
  return {
    queue: game.buzzQueue.map((b) => ({ name: nameOf(b.token), elapsedMs: b.elapsedMs })),
    wrong: [...game.buzzWrong].map(nameOf),
    winner: game.winner ? nameOf(game.winner) : null,
    my,
    myPosition: pos + 1,
  };
}

// ---------- 配信 ----------
function playerList() {
  return [...players.values()]
    .map(({ token, name, score, connected }) => ({ token, name, score, connected }))
    .sort((a, b) => b.score - a.score);
}

function publicState(token) {
  const q = currentQuestion();
  const showQ = q && game.phase !== 'lobby' && game.phase !== 'finished';
  const revealed = game.phase === 'revealed';
  const my = token ? game.answers.get(token) : null;
  return {
    phase: game.phase,
    index: game.index,
    total: questions.length,
    remainingMs: game.phase === 'question' && game.deadline ? Math.max(0, game.deadline - Date.now()) : null,
    question: showQ
      ? {
          // 早押しで「問題文を表示しない」場合は、出題者が読み上げる前提で正解発表まで隠す
          text: q.type === 'buzzer' && !q.showText && !revealed ? null : q.text,
          type: q.type,
          image: q.image || null,
          penalty: q.penalty ?? 0,
          choices: q.type === 'choice' ? q.choices : null,
          points: q.points,
          answer: revealed ? q.answer : null,
        }
      : null,
    answeredCount: game.answers.size,
    buzz: showQ && q.type === 'buzzer' ? buzzInfo(token) : null,
    myAnswer: my ? { answer: my.answer, correct: revealed ? my.correct : null } : null,
    ranking: playerList().map(({ name, score, connected }) => ({ name, score, connected })),
    me: token && players.has(token) ? { name: players.get(token).name, score: players.get(token).score } : null,
    showRanking: game.showRanking,
  };
}

// 会場スクリーン用：正解発表後の集計（選択肢ごとの人数・正解者）を追加
function screenState() {
  const s = publicState(null);
  s.onlineCount = [...players.values()].filter((p) => p.connected).length;
  const q = currentQuestion();
  if (game.phase === 'revealed' && q && q.type !== 'buzzer') {
    const sorted = [...game.answers.entries()].sort((a, b) => a[1].elapsedMs - b[1].elapsedMs);
    s.stats = {
      choiceCounts: q.type === 'choice' ? q.choices.map((_, i) => sorted.filter(([, a]) => a.answer === i).length) : null,
      correct: sorted.filter(([, a]) => a.correct).map(([t, a]) => ({ name: nameOf(t), elapsedMs: a.elapsedMs })),
      answered: sorted.length,
    };
  }
  return s;
}

function hostState() {
  const answers = [...game.answers.entries()]
    .map(([token, a]) => ({ token, name: players.get(token)?.name ?? '?', ...a }))
    .sort((a, b) => a.elapsedMs - b.elapsedMs);
  const online = [...players.values()].filter((p) => p.connected);
  const allAnswered = online.length > 0 && online.every((p) => game.answers.has(p.token));
  return { ...publicState(null), allAnswered, questions, players: playerList(), answers, currentQuestion: currentQuestion() ?? null };
}

function broadcast() {
  for (const p of players.values()) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', publicState(p.token));
  }
  if (hostSocketId) io.to(hostSocketId).emit('hostState', hostState());
  io.to('screens').emit('screenState', screenState());
}

// ---------- 進行 ----------
function clearTimer() {
  if (game.timer) clearTimeout(game.timer);
  game.timer = null;
}

function startQuestion(index) {
  if (index < 0 || index >= questions.length) return;
  clearTimer();
  game.index = index;
  game.phase = 'question';
  game.answers = new Map();
  game.buzzQueue = [];
  game.buzzWrong = new Set();
  game.winner = null;
  game.showRanking = false;
  game.startedAt = Date.now();
  const limit = questions[index].timeLimit;
  game.deadline = limit > 0 ? game.startedAt + limit * 1000 : 0;
  if (limit > 0) game.timer = setTimeout(closeQuestion, limit * 1000);
}

function closeQuestion() {
  clearTimer();
  if (game.phase === 'question') {
    game.phase = 'closed';
    broadcast();
  }
}

function reveal() {
  clearTimer();
  if (game.phase !== 'question' && game.phase !== 'closed') return;
  const q = currentQuestion();
  for (const [token, a] of game.answers) {
    if (a.correct) {
      const p = players.get(token);
      if (p) p.score += q.points;
    }
  }
  game.phase = 'revealed';
}

// ---------- ソケット ----------
io.on('connection', (socket) => {
  const isHost = () => socket.id === hostSocketId;

  // 回答者
  socket.on('player:join', ({ name, token } = {}, ack = () => {}) => {
    let p = token && players.get(token);
    if (!p) {
      name = String(name || '').trim().slice(0, 20);
      if (!name) return ack({ error: '名前を入力してください' });
      if ([...players.values()].some((x) => x.name === name)) return ack({ error: 'その名前は既に使われています' });
      if (players.size >= MAX_PLAYERS) return ack({ error: `参加者が上限（${MAX_PLAYERS}人）に達しています` });
      p = { token: crypto.randomUUID(), name, score: 0 };
      players.set(p.token, p);
    }
    p.socketId = socket.id;
    p.connected = true;
    socket.data.token = p.token;
    ack({ token: p.token, name: p.name });
    broadcast();
  });

  socket.on('player:answer', (answer, ack = () => {}) => {
    const token = socket.data.token;
    const q = currentQuestion();
    if (!token || !players.has(token)) return ack({ error: '参加していません' });
    if (game.phase !== 'question') return ack({ error: '回答受付中ではありません' });
    if (game.answers.has(token)) return ack({ error: '回答済みです' });
    if (q.type === 'buzzer') return ack({ error: '早押し問題です' });
    if (q.type === 'choice') {
      answer = Number(answer);
      if (!Number.isInteger(answer) || answer < 0 || answer >= q.choices.length) return ack({ error: '不正な回答です' });
    } else {
      answer = String(answer ?? '').trim().slice(0, 200);
      if (!answer) return ack({ error: '回答を入力してください' });
    }
    game.answers.set(token, { answer, elapsedMs: Date.now() - game.startedAt, correct: autoJudge(q, answer) });
    ack({ ok: true });
    // 回答の取り消しができるよう、全員回答しても自動では締め切らない（出題者画面に「全員回答済み」を表示）
    broadcast();
  });

  // 回答の取り消し（受付中のみ。取り消した後は選び直せる）
  socket.on('player:cancel', (_, ack = () => {}) => {
    const token = socket.data.token;
    if (game.phase !== 'question') return ack({ error: '回答の受付が終わったため取り消せません' });
    if (!token || !game.answers.delete(token)) return ack({ error: 'まだ回答していません' });
    ack({ ok: true });
    broadcast();
  });

  // 会場スクリーン（閲覧専用。正解は発表後にしか送らないので認証なし）
  socket.on('screen:join', () => {
    socket.join('screens');
    socket.emit('screenState', screenState());
  });

  socket.on('player:buzz', (_, ack = () => {}) => {
    const token = socket.data.token;
    const q = currentQuestion();
    if (!token || !players.has(token)) return ack({ error: '参加していません' });
    if (game.phase !== 'question' || q.type !== 'buzzer') return ack({ error: '早押し受付中ではありません' });
    if (game.buzzWrong.has(token)) return ack({ error: 'この問題の回答権はありません' });
    if (game.buzzQueue.some((b) => b.token === token)) return ack({ error: '押し済みです' });
    game.buzzQueue.push({ token, elapsedMs: Date.now() - game.startedAt });
    ack({ ok: true, position: game.buzzQueue.length });
    io.emit('buzzed', { name: nameOf(token), position: game.buzzQueue.length });
    broadcast();
  });

  // 出題者
  socket.on('host:login', (password, ack = () => {}) => {
    const authError = checkHostPassword(clientIp(socket.handshake.headers, socket.handshake.address), password);
    if (authError) return ack({ error: authError });
    if (hostSocketId && hostSocketId !== socket.id) io.to(hostSocketId).emit('host:kicked');
    hostSocketId = socket.id;
    ack({ ok: true });
    broadcast();
  });

  const hostOnly = (event, fn) =>
    socket.on(event, (...args) => {
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : () => {};
      if (!isHost()) return ack({ error: '出題者としてログインしていません' });
      const result = fn(...args);
      ack(result || { ok: true });
      broadcast();
    });

  hostOnly('host:saveQuestions', (list) => {
    if (!Array.isArray(list)) return { error: '形式が不正です' };
    if (game.phase === 'question' || game.phase === 'closed') return { error: '出題中は問題を編集できません' };
    questions = list.map(sanitizeQuestion);
    saveQuestions();
  });
  hostOnly('host:start', (index) => {
    if (!questions[index]) return { error: '問題がありません' };
    startQuestion(index);
  });
  hostOnly('host:close', () => closeQuestion());
  hostOnly('host:reveal', () => reveal());
  hostOnly('host:judge', ({ token, correct }) => {
    // 正解発表前の判定修正（記述式の表記ゆれ対応など）
    const a = game.answers.get(token);
    if (!a) return { error: '回答が見つかりません' };
    if (game.phase === 'revealed') {
      const p = players.get(token);
      if (p && a.correct !== !!correct) p.score += correct ? currentQuestion().points : -currentQuestion().points;
    }
    a.correct = !!correct;
  });
  hostOnly('host:buzzJudge', ({ correct } = {}) => {
    const q = currentQuestion();
    if (!q || q.type !== 'buzzer' || (game.phase !== 'question' && game.phase !== 'closed')) return { error: '早押し問題の出題中ではありません' };
    const first = game.buzzQueue[0];
    if (!first) return { error: 'まだ誰も押していません' };
    const p = players.get(first.token);
    if (correct) {
      if (p) p.score += q.points;
      game.winner = first.token;
      clearTimer();
      game.phase = 'revealed';
      return;
    }
    if (p) p.score -= q.penalty;
    game.buzzWrong.add(first.token);
    game.buzzQueue.shift();
    // 参加中の全員が誤答したら締め切る
    const online = [...players.values()].filter((x) => x.connected);
    if (game.buzzQueue.length === 0 && online.every((x) => game.buzzWrong.has(x.token))) closeQuestion();
  });
  hostOnly('host:buzzReset', () => {
    // 押した人の順番待ちを解除（誤答者の回答権は戻さない）
    game.buzzQueue = [];
  });
  hostOnly('host:showRanking', (show) => {
    game.showRanking = !!show;
  });
  hostOnly('host:adjustScore', ({ token, delta }) => {
    const p = players.get(token);
    if (p) p.score += Math.round(Number(delta) || 0);
  });
  hostOnly('host:kick', (token) => {
    const p = players.get(token);
    if (!p) return;
    if (p.socketId) io.to(p.socketId).emit('kicked');
    players.delete(token);
    game.answers.delete(token);
    game.buzzQueue = game.buzzQueue.filter((b) => b.token !== token);
  });
  hostOnly('host:finish', () => {
    clearTimer();
    game.phase = 'finished';
  });
  hostOnly('host:reset', ({ keepPlayers } = {}) => {
    clearTimer();
    Object.assign(game, { phase: 'lobby', index: -1, startedAt: 0, deadline: 0, answers: new Map(), buzzQueue: [], buzzWrong: new Set(), winner: null, showRanking: false });
    if (keepPlayers) players.forEach((p) => (p.score = 0));
    else {
      for (const p of players.values()) if (p.socketId) io.to(p.socketId).emit('kicked');
      players.clear();
    }
  });

  socket.on('disconnect', () => {
    if (isHost()) hostSocketId = null;
    const p = socket.data.token && players.get(socket.data.token);
    if (p && p.socketId === socket.id) p.connected = false;
    broadcast();
  });
});

server.listen(PORT, () => {
  console.log('クイズ大会サーバー起動');
  console.log(`  回答者:     http://localhost:${PORT}/`);
  console.log(`  出題者:     http://localhost:${PORT}/host  (パスワード: ${pwNote()})`);
  console.log(`  スクリーン: http://localhost:${PORT}/screen`);
  if (ONLINE) return startTunnel();
  lanIps().forEach((ip) => console.log(`  LAN内:      http://${ip}:${PORT}/`));
  console.log(`  QRコードの参加URL: ${JOIN_URL}`);
});

// ---------- インターネット公開（Cloudflare Quick Tunnel） ----------
// アカウント不要で https://xxxx.trycloudflare.com のURLが発行される（起動するたびに変わる）
function startTunnel() {
  const { Tunnel } = require('cloudflared');
  console.log('\nインターネット公開用のトンネルを準備しています…');
  const tunnel = Tunnel.quick(`http://localhost:${PORT}`);
  tunnel.once('url', (url) => {
    JOIN_URL = process.env.PUBLIC_URL || `${url}/`;
    console.log('\n================ インターネット公開中 ================');
    console.log(`  回答者:     ${url}/`);
    console.log(`  出題者:     ${url}/host`);
    console.log(`  スクリーン: ${url}/screen`);
    console.log(`  出題者パスワード: ${pwNote()}`);
    console.log('  ※ このウィンドウを閉じると公開も終了します');
    console.log('======================================================\n');
    io.to('screens').emit('joinInfoChanged');
  });
  tunnel.on('error', (e) => console.error('トンネルのエラー:', e.message));
  tunnel.on('exit', (code) => console.error(`トンネルが終了しました (code ${code})。インターネットからは接続できません。`));
  const stop = () => { tunnel.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function pwNote() {
  if (process.env.HOST_PASSWORD) return '（HOST_PASSWORD で設定した値）';
  return ONLINE ? HOST_PASSWORD : 'admin ※HOST_PASSWORD で変更可';
}
