'use strict';

/* ============================================================
   フレーズデッキ  —  iPhone 単体アプリ (登録も学習も端末内)
   - 初期データ: data/phrases.json (28件のシード)
   - 追加データ: localStorage (端末内のみ・公開されない)
   - 登録時のエンリッチ: iPhone から直接 Claude API を叩く
     (APIキーは端末内 localStorage だけに保存)
   - 学習進捗: localStorage に Leitner ベースの SRS で保存
   ============================================================ */

const SEED_URL = 'data/phrases.json';
const DECK_KEY = 'phrasedeck.deck.v1';     // ユーザーが追加した items
const STORE_KEY = 'phrasedeck.srs.v1';     // SRS 進捗
const APIKEY_KEY = 'phrasedeck.apikey';
const STAR_KEY = 'phrasedeck.stars.v1';    // 特に覚えたい(★)の id 集合
const DAILY_KEY = 'phrasedeck.daily.v1';   // 日別の学習ログ {ISO: {reviews, ms}}

// 「やさしい英語先生」カスタム GPT。?q= で英語フレーズを入力欄にプリフィル。
const TEACHER_GPT_URL = 'https://chatgpt.com/g/g-68114d4beb74819189947148dab70783-yasasiiying-yu-xian-sheng';
function teacherUrl(en) {
  return `${TEACHER_GPT_URL}?q=${encodeURIComponent(en)}`;
}

// 1枚あたりの学習時間の上限(置きっぱなし対策)。これ以上は加算しない。
const CARD_TIME_CAP = 120000;

// エンリッチに使うモデル。コスト重視で Sonnet。品質優先なら 'claude-opus-4-8'。
const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const DAY = 86400000;
const BOX_INTERVALS = [0, 1, 3, 7, 14, 30];
const NEW_PER_DAY = 8;
const MAX_BOX = BOX_INTERVALS.length - 1;

/* ---------- 徹底モード（会話の骨組み） ----------
   通常の SRS とは別勘定。30文で1パック。「3日ぶん連続で言えたら卒業」。
   同じ日に何度正解しても連続日数は 1 しか進まない（詰め込みで卒業できない）。
   1回でも言えなければ連続日数は 0 に戻り、そのセッション中に必ず再登場する。
   パックの30文がすべて卒業すると、次のパックが開く。
   卒業した文はパックをまたいで「復習」に貯まり、いつでも全部まとめて回せる。 */
const CORE_THEME = '会話の骨組み';
const DRILL_KEY = 'phrasedeck.drill.v1';
const DRILL_GOAL = 3;                  // 卒業に必要な「連続で言えた日数」
const DRILL_REQUEUE_GAP = 3;           // 言えなかったカードが再登場するまでの枚数

const THEMES = [
  '裁判員の話', '魚市場・仕事', 'お店・レストラン', '高松の暮らし・食',
  '一人の時間・性格', '果物・地方', 'あいさつ・近況', '一般表現',
];

let SEED = [];        // phrases.json
let DECK = [];        // localStorage 追加分
let ITEMS = [];       // SEED + DECK
let BY_ID = {};
let srs = {};
let mode = 'recall';
let queue = [];
let current = null;
let revealed = false;
let sessionTheme = null;   // 直近セッションのテーマ
let drill = {};            // 徹底モードの進捗 { id: {streak, lastDay, done, doneAt} }
let drillMode = false;     // false | 'pack'（新規パック） | 'review'（卒業ぶんの復習）
let drillPackNo = 0;       // 今やっているパック番号（'pack' セッション用）

/* ---------- 永続化 ---------- */
function loadSrs() {
  try { srs = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
  catch { srs = {}; }
}
function saveSrs() { localStorage.setItem(STORE_KEY, JSON.stringify(srs)); }

function loadDeck() {
  try { DECK = JSON.parse(localStorage.getItem(DECK_KEY)) || []; }
  catch { DECK = []; }
}
function saveDeck() { localStorage.setItem(DECK_KEY, JSON.stringify(DECK)); }

function getApiKey() { return localStorage.getItem(APIKEY_KEY) || ''; }
function setApiKey(v) { localStorage.setItem(APIKEY_KEY, v); }

/* ---------- 日別の学習ログ ---------- */
let daily = {};
let cardShownTs = 0;   // 現在のカードを表示した時刻(分の計測用)
function loadDaily() {
  try { daily = JSON.parse(localStorage.getItem(DAILY_KEY)) || {}; }
  catch { daily = {}; }
}
function saveDaily() { localStorage.setItem(DAILY_KEY, JSON.stringify(daily)); }
function recordStudy(ms) {
  const key = todayISO();
  const d = daily[key] || { reviews: 0, ms: 0 };
  d.reviews += 1;
  d.ms += Math.max(0, ms);
  daily[key] = d;
  saveDaily();
}

/* ---------- 星マーク（特に覚えたい） ---------- */
let STARS = new Set();
function loadStars() {
  try { STARS = new Set(JSON.parse(localStorage.getItem(STAR_KEY)) || []); }
  catch { STARS = new Set(); }
}
function saveStars() { localStorage.setItem(STAR_KEY, JSON.stringify([...STARS])); }
function isStarred(id) { return STARS.has(id); }
function toggleStar(id) {
  if (STARS.has(id)) STARS.delete(id); else STARS.add(id);
  saveStars();
  return STARS.has(id);
}
function starBtnHtml(id, extraClass) {
  const on = isStarred(id);
  return `<button class="star-btn${extraClass ? ' ' + extraClass : ''}${on ? ' on' : ''}" `
    + `data-id="${esc(id)}" aria-label="特に覚えたい">${on ? '★' : '☆'}</button>`;
}
function wireStarBtn(btn, after) {
  btn.onclick = (e) => {
    e.stopPropagation();
    const on = toggleStar(btn.dataset.id);
    btn.classList.toggle('on', on);
    btn.textContent = on ? '★' : '☆';
    if (after) after(on);
  };
}

function todayStart() {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
}

/* ---------- データ構築 ---------- */
async function loadData() {
  let seedJson = { items: [] };
  try {
    const res = await fetch(SEED_URL + '?_=' + Date.now());
    seedJson = await res.json();
  } catch { /* オフラインでも DECK だけで動く */ }
  SEED = seedJson.items || [];
  loadDeck();
  migrateSeedToDeck();
  rebuildItems();
  document.getElementById('verLine').textContent =
    `収録 ${ITEMS.length} 件（うち追加 ${DECK.length} 件）`;
}

// 公開シードの28件を端末内(DECK)へ一度だけ退避。
// これにより公開 phrases.json を空にしても、端末では28件と進捗が残る。
function migrateSeedToDeck() {
  if (localStorage.getItem('phrasedeck.migrated.v1')) return;
  if (!SEED.length) return;   // オフライン等で空なら次回に持ち越し(フラグ立てない)
  const deckIds = new Set(DECK.map(it => it.id));
  let added = 0;
  for (const it of SEED) {
    if (!deckIds.has(it.id)) { DECK.push(JSON.parse(JSON.stringify(it))); added++; }
  }
  if (added) saveDeck();
  localStorage.setItem('phrasedeck.migrated.v1', '1');
}

function rebuildItems() {
  const seen = new Set();
  ITEMS = [];
  for (const it of SEED.concat(DECK)) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    ITEMS.push(it);
  }
  BY_ID = {};
  ITEMS.forEach(it => BY_ID[it.id] = it);
}

/* ---------- 出題キュー ---------- */
function buildQueue(theme) {
  const now = Date.now();
  const dueIds = [];
  const newIds = [];
  for (const it of ITEMS) {
    if (theme && it.theme !== theme) continue;
    // 骨組み30 は徹底モードの専任。ふだんの復習では二重に出さない。
    if (!theme && it.theme === CORE_THEME) continue;
    const s = srs[it.id];
    if (!s) { newIds.push(it.id); continue; }
    if (s.due <= now) dueIds.push(it.id);
  }
  dueIds.sort((a, b) => (srs[a].due) - (srs[b].due));
  const newToday = countNewToday();
  const room = theme ? newIds.length : Math.max(0, NEW_PER_DAY - newToday);
  const picked = dueIds.concat(newIds.slice(0, room));
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor((i + 1) * pseudoRandom(picked[i]));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }
  return picked;
}

// 今日学習したカードのID（おかわりの対象）
function todayStudiedIds() {
  const t0 = todayStart();
  return ITEMS.filter(it => srs[it.id] && srs[it.id].last >= t0).map(it => it.id);
}

// おかわり: 今日やった単語をシャッフルしてもう一周。
// まだ今日やっていなければ、デッキ全体から練習。採点は通常どおりSRSに反映。
function buildExtraQueue() {
  let ids = todayStudiedIds();
  if (!ids.length) ids = ITEMS.filter(it => it.theme !== CORE_THEME).map(it => it.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids;
}

function pseudoRandom(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return (h % 1000) / 1000;
}

function countNewToday() {
  const t0 = todayStart();
  return Object.values(srs).filter(s => s.firstSeen && s.firstSeen >= t0).length;
}

function dueCountAll() {
  const now = Date.now();
  const pool = ITEMS.filter(it => it.theme !== CORE_THEME);
  let due = 0;
  for (const it of pool) {
    const s = srs[it.id];
    if (s && s.due <= now) due++;
  }
  const newRoom = Math.max(0, NEW_PER_DAY - countNewToday());
  const newAvail = pool.filter(it => !srs[it.id]).length;
  return due + Math.min(newRoom, newAvail);
}

/* ---------- 採点 ---------- */
function grade(item, g) {
  const s = srs[item.id] || { box: 0, seen: 0 };
  if (!s.firstSeen) s.firstSeen = Date.now();
  if (g === 'again') s.box = Math.max(0, s.box - 1);
  else if (g === 'hard') s.box = Math.max(0, s.box);
  else s.box = Math.min(MAX_BOX, s.box + 1);
  const interval = g === 'again' ? 0 : BOX_INTERVALS[s.box];
  s.due = g === 'again' ? Date.now() : (todayStart() + interval * DAY);
  s.seen = (s.seen || 0) + 1;
  const now = Date.now();
  s.last = now;
  srs[item.id] = s;
  saveSrs();
  // 学習ログ(日別の回数・時間)。カード表示〜採点までを上限付きで加算。
  recordStudy(cardShownTs ? Math.min(now - cardShownTs, CARD_TIME_CAP) : 0);
  cardShownTs = now;
  if (g === 'again') queue.push(item.id);
}

// 採点の入口。徹底モードとふつうの復習で採点の意味が違うので、ここで振り分ける。
function gradeCurrent(g) {
  if (drillMode) return gradeDrill(current, g === 'ok');
  grade(current, g);
}

/* ---------- 徹底モード ---------- */
function loadDrill() {
  try { drill = JSON.parse(localStorage.getItem(DRILL_KEY)) || {}; }
  catch { drill = {}; }
}
function saveDrill() { localStorage.setItem(DRILL_KEY, JSON.stringify(drill)); }

function coreItems() { return ITEMS.filter(it => it.theme === CORE_THEME); }

// pack が無い古いデータはパック1 とみなす。
function packOf(it) { return Number(it.pack) || 1; }
function packItems(no) { return coreItems().filter(it => packOf(it) === no); }
function packNumbers() {
  return [...new Set(coreItems().map(packOf))].sort((a, b) => a - b);
}
function packTitle(no) {
  const it = packItems(no)[0];
  return (it && it.pack_title) || `パック${no}`;
}

// いま開いているパック＝まだ全部は卒業していない、いちばん若いパック。
// すべて卒業ずみなら 0（新しいパック待ち）。
function currentPackNo() {
  for (const no of packNumbers()) {
    const items = packItems(no);
    if (items.some(it => !drillState(it.id).done)) return no;
  }
  return 0;
}

function drillState(id) {
  return drill[id] || { streak: 0, lastDay: '', done: false, doneAt: 0 };
}

// 今日クリアすべき文＝このパックのうち、まだ卒業しておらず今日まだ言えていないもの。
function buildDrillQueue(no) {
  const today = todayISO();
  const todo = [];
  for (const it of packItems(no)) {
    const st = drillState(it.id);
    if (st.done) continue;
    if (st.lastDay === today) continue;
    todo.push(it.id);
  }
  // 連続日数が少ない（＝苦手な）ものから
  todo.sort((a, b) => drillState(a).streak - drillState(b).streak);
  return todo;
}

function shuffled(ids) {
  const a = ids.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 今日やる分をすべてクリアした後の「おかわり」。連続日数は動かさない。
function buildDrillExtraQueue(no) {
  return shuffled(packItems(no).map(it => it.id));
}

// 復習＝卒業した文ぜんぶ。パックをまたいでシャッフルし、上限なしで1周する。
function graduatedIds() {
  return coreItems().filter(it => drillState(it.id).done).map(it => it.id);
}
function buildReviewQueue() { return shuffled(graduatedIds()); }

function gradeDrill(item, ok) {
  const st = drillState(item.id);
  const today = todayISO();
  const now = Date.now();
  if (drillMode === 'review') {
    // 復習では卒業を取り消さない。取り消すとパックの完了判定が揺れてしまう。
    // 言えなければ、そのセッション中にもう一度出すだけ。
    if (ok) { st.reviewOk = (st.reviewOk || 0) + 1; }
    else {
      st.reviewNg = (st.reviewNg || 0) + 1;
      queue.splice(Math.min(DRILL_REQUEUE_GAP, queue.length), 0, item.id);
    }
    st.lastReview = now;
  } else if (ok) {
    if (st.lastDay !== today) {
      st.streak = (st.streak || 0) + 1;
      st.lastDay = today;
      if (st.streak >= DRILL_GOAL) { st.done = true; st.doneAt = now; }
    }
  } else {
    // 言えなければ振り出しに戻す。
    st.streak = 0;
    st.lastDay = '';
    // 同じセッション中に必ずもう一度出す
    queue.splice(Math.min(DRILL_REQUEUE_GAP, queue.length), 0, item.id);
  }
  st.seen = (st.seen || 0) + 1;
  drill[item.id] = st;
  saveDrill();
  recordStudy(cardShownTs ? Math.min(now - cardShownTs, CARD_TIME_CAP) : 0);
  cardShownTs = now;
}

function drillSummary() {
  const no = currentPackNo();
  const nums = packNumbers();
  const items = no ? packItems(no) : [];
  const today = todayISO();
  let done = 0, clearedToday = 0;
  for (const it of items) {
    const st = drillState(it.id);
    if (st.done) { done++; clearedToday++; continue; }
    if (st.lastDay === today) clearedToday++;
  }
  return {
    pack: no,
    title: no ? packTitle(no) : '',
    packIndex: no ? nums.indexOf(no) + 1 : nums.length,
    packCount: nums.length,
    total: items.length,
    done, clearedToday,
    remaining: no ? buildDrillQueue(no).length : 0,
    graduated: graduatedIds().length,
    coreTotal: coreItems().length,
  };
}

// レッスン前に「今日これを使う」と決めるための3文。苦手なものから選ぶ。
function pickThreeForToday() {
  const no = currentPackNo();
  const rest = (no ? packItems(no) : [])
    .filter(it => !drillState(it.id).done)
    .sort((a, b) => drillState(a).streak - drillState(b).streak);
  // 卒業が進んで残りが3未満になったら、卒業ずみからも補って必ず3文出す。
  const grad = shuffled(graduatedIds()).map(id => BY_ID[id]).filter(Boolean);
  return rest.concat(grad).slice(0, 3);
}

/* ---------- 音声(TTS) ---------- */
const VOICE_KEY = 'phrasedeck.voice';
const RATE_KEY = 'phrasedeck.rate';
const MUTE_KEY = 'phrasedeck.muted';
const NOVELTY = [
  'albert', 'bad news', 'bahh', 'bells', 'boing', 'bubbles', 'cellos', 'wobble',
  'good news', 'jester', 'organ', 'pipe organ', 'superstar', 'trinoids', 'whisper',
  'zarvox', 'junior', 'ralph', 'fred', 'kathy', 'deranged', 'hysterical', 'princess',
  'eddy', 'flo', 'grandma', 'grandpa', 'reed', 'rocko', 'sandy', 'shelley',
];
const PREFERRED = [
  'samantha', 'ava', 'allison', 'susan', 'siri', 'serena', 'karen',
  'daniel', 'kate', 'moira', 'tessa', 'nicky', 'aaron', 'alex', 'tom',
];

let VOICES = [];
let speechRate = parseFloat(localStorage.getItem(RATE_KEY)) || 0.95;
let muted = localStorage.getItem(MUTE_KEY) === '1';

function isNovelty(v) {
  const n = v.name.toLowerCase();
  return NOVELTY.some(bad => n.includes(bad));
}
function englishVoices() {
  return VOICES.filter(v => /^en(-|_|$)/i.test(v.lang) && !isNovelty(v));
}
function refreshVoices() {
  VOICES = ('speechSynthesis' in window) ? window.speechSynthesis.getVoices() : [];
}
function autoVoiceName() {
  const en = englishVoices();
  if (!en.length) return '';
  const score = v => {
    const n = v.name.toLowerCase();
    let s = 0;
    const idx = PREFERRED.findIndex(p => n.includes(p));
    if (idx >= 0) s += (PREFERRED.length - idx) * 10;
    if (/enhanced|premium/i.test(v.name)) s += 8;
    if (/en[-_]US/i.test(v.lang)) s += 4;
    if (v.localService) s += 2;
    if (v.default) s += 1;
    return s;
  };
  return en.slice().sort((a, b) => score(b) - score(a))[0].name;
}
function currentVoiceName() {
  const saved = localStorage.getItem(VOICE_KEY);
  if (saved && VOICES.some(v => v.name === saved)) return saved;
  return autoVoiceName();
}
function speak(text, rate) {
  if (muted) return;
  if (!('speechSynthesis' in window)) return;
  if (!VOICES.length) refreshVoices();
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const name = currentVoiceName();
  const v = VOICES.find(x => x.name === name);
  if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'en-US'; }
  u.rate = rate != null ? rate : speechRate;
  u.pitch = 1.0;
  u.volume = 1.0;
  window.speechSynthesis.speak(u);
}

function renderMuteBtn() {
  const b = document.getElementById('muteBtn');
  if (!b) return;
  b.textContent = muted ? '🔇' : '🔊';
  b.classList.toggle('muted', muted);
  b.title = muted ? '音: オフ（タップでオン）' : '音: オン（タップでオフ）';
}

/* ---------- 画面遷移 ---------- */
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function refreshTop() {
  // 徹底モード中は「このセッションの残り枚数」を出す（言えなければ増える）。
  const n = drillMode ? queue.length + (current ? 1 : 0) : dueCountAll();
  document.getElementById('dueCount').textContent = n;
}

/* ---------- カード描画 ---------- */
function nextCard() {
  revealed = false;
  while (queue.length) {
    const id = queue.shift();
    const it = BY_ID[id];
    if (!it) continue;
    current = it;
    renderCard();
    return;
  }
  renderDone();
}

// 徹底モードのカード上部：あと何日連続で言えれば卒業かを見せる。
function drillMeterHtml(id) {
  const st = drillState(id);
  if (drillMode === 'review') return `<div class="drill-meter done">復習 ─ 卒業した文</div>`;
  const dots = Array.from({ length: DRILL_GOAL }, (_, i) =>
    `<span class="dot${i < st.streak ? ' on' : ''}"></span>`).join('');
  return `<div class="drill-meter">${dots}<span class="drill-meter-label">連続 ${st.streak}/${DRILL_GOAL} 日</span></div>`;
}

function renderCard() {
  const it = current;
  cardShownTs = Date.now();
  const area = document.getElementById('cardArea');
  const diffStars = '★'.repeat(it.difficulty || 1) + '☆'.repeat(3 - (it.difficulty || 1));
  // 徹底モードのときは、テーマ名よりパック名のほうが今やっていることが分かる。
  const tag = drillMode && it.theme === CORE_THEME ? (it.pack_title || it.theme) : it.theme;
  area.innerHTML = `
    <div class="card">
      <div class="card-top">
        <span class="theme-tag">${esc(tag)}<span class="type-tag">${it.type === 'word' ? '単語' : 'フレーズ'}</span></span>
        ${starBtnHtml(it.id, 'card-star')}
      </div>
      ${drillMode ? drillMeterHtml(it.id) : `<div class="difficulty">難易度 ${diffStars}</div>`}
      <div class="situation">${esc(it.situation_ja)}</div>
      <div class="prompt-ja">${esc(it.ja)}</div>
      <div id="answerZone"></div>
    </div>`;
  const star = area.querySelector('.card-star');
  if (star) wireStarBtn(star);
  renderAnswerZone();
}

function renderAnswerZone() {
  const zone = document.getElementById('answerZone');
  if (mode === 'type') return renderTypeMode(zone);
  if (mode === 'shadow') return renderShadowMode(zone);
  return renderRecallMode(zone);
}

function renderRecallMode(zone) {
  if (!revealed) {
    zone.innerHTML = `<div class="tap-hint">英語で言ってみる → タップで答え合わせ</div>`;
    zone.parentElement.onclick = () => { revealed = true; renderRecallMode(zone); };
    return;
  }
  zone.parentElement.onclick = null;
  zone.innerHTML = revealHtml(current) + gradeRowHtml();
  wireReveal(zone);
  zone.querySelectorAll('.grade-row button').forEach(b => {
    b.onclick = () => { gradeCurrent(b.dataset.g); refreshTop(); nextCard(); };
  });
  speak(current.en[0]);
}

function renderTypeMode(zone) {
  if (!revealed) {
    zone.innerHTML = `
      <div class="type-box">
        <input id="answerInput" type="text" autocapitalize="off" autocorrect="off"
               spellcheck="false" placeholder="英語で入力" />
        <button class="check-btn" id="checkBtn">答え合わせ</button>
        <div class="judge" id="judge"></div>
      </div>`;
    const input = zone.querySelector('#answerInput');
    input.focus();
    const check = () => {
      const ok = isCorrect(input.value, current.en);
      const j = zone.querySelector('#judge');
      j.textContent = ok ? '◎ 正解！' : '✕ おしい / 確認しよう';
      j.className = 'judge ' + (ok ? 'ok' : 'ng');
      revealed = true;
      setTimeout(() => {
        zone.innerHTML = revealHtml(current) + gradeRowHtml(ok);
        wireReveal(zone);
        zone.querySelectorAll('.grade-row button').forEach(b => {
          b.onclick = () => { gradeCurrent(b.dataset.g); refreshTop(); nextCard(); };
        });
        speak(current.en[0]);
      }, 700);
    };
    zone.querySelector('#checkBtn').onclick = check;
    input.onkeydown = e => { if (e.key === 'Enter') check(); };
  }
}

function renderShadowMode(zone) {
  zone.innerHTML = `
    ${revealHtml(current)}
    <div class="shadow-box">
      <button class="play" id="playBtn">▶ 手本を聞く</button>
      <button class="slow" id="slowBtn">🐢 ゆっくり</button>
    </div>
    ${gradeRowHtml()}`;
  wireReveal(zone);
  zone.querySelector('#playBtn').onclick = () => speak(current.en[0], 1.0);
  zone.querySelector('#slowBtn').onclick = () => speak(current.en[0], 0.6);
  zone.querySelectorAll('.grade-row button').forEach(b => {
    b.onclick = () => { gradeCurrent(b.dataset.g); refreshTop(); nextCard(); };
  });
  speak(current.en[0]);
}

/* ---------- 共通パーツ ---------- */
function revealHtml(it) {
  const main = it.en[0];
  const alts = it.en.slice(1);
  const related = (it.related || []).map(rid => {
    const r = BY_ID[rid];
    return r ? `<span class="chip">${esc(r.en[0])}</span>` : '';
  }).join('');
  return `
    <div class="reveal">
      <div class="en-line"><button class="spk" data-en="${esc(main)}">🔊</button><span>${esc(main)}</span></div>
      ${alts.map(a => `<div class="alt">= ${esc(a)}</div>`).join('')}
      ${it.advice_ja ? `<div class="advice">💡 ${esc(it.advice_ja)}</div>` : ''}
      ${related ? `<div class="related"><h4>関連表現</h4>${related}</div>` : ''}
      <a class="teacher-btn" href="${esc(teacherUrl(main))}" target="_blank" rel="noopener" data-en="${esc(main)}">👨‍🏫 先生に質問する</a>
    </div>`;
}
function wireReveal(zone) {
  const spk = zone.querySelector('.spk');
  if (spk) spk.onclick = (e) => { e.stopPropagation(); speak(spk.dataset.en); };
  const teacher = zone.querySelector('.teacher-btn');
  if (teacher) teacher.onclick = (e) => {
    e.stopPropagation();
    // iPhone はリンクの ?q= がアプリ側で無視されるため、確実にコピーしてから開く。
    // navigator.clipboard は非同期で、リンク遷移→フォーカス喪失でキャンセルされるため
    // iOS では同期完結する execCommand('copy') 方式を使う。preventDefault はしない。
    const en = teacher.dataset.en || '';
    const ok = copyTextSync(en);
    toast(ok ? 'フレーズをコピーしました。先生に貼り付けて送ってね' : 'コピーできませんでした。手入力してね');
  };
}

// iOS Safari/PWA でユーザー操作中に同期コピーするためのフォールバック実装。
function copyTextSync(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.contentEditable = 'true';
    ta.readOnly = false;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ta.setSelectionRange(0, text.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    // 念のため非同期 API も試す(対応ブラウザでより確実に)
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    return ok;
  } catch (_) {
    if (navigator.clipboard) { navigator.clipboard.writeText(text).catch(() => {}); return true; }
    return false;
  }
}

let toastTimer = null;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
function gradeRowHtml() {
  // 徹底モードは「言えたか、言えなかったか」の2択だけ。
  // あやふや＝言えなかった、として扱わないと連続日数が意味を持たなくなる。
  if (drillMode) {
    return `
      <div class="grade-row drill">
        <button class="again" data-g="ng">言えなかった<small>今すぐまた出る</small></button>
        <button class="good" data-g="ok">言えた<small>${drillMode === 'review' ? '次へ' : '連続日数 +1'}</small></button>
      </div>`;
  }
  return `
    <div class="grade-row">
      <button class="again" data-g="again">もう一度<small>今日また</small></button>
      <button class="hard" data-g="hard">あやふや<small>翌日</small></button>
      <button class="good" data-g="good">覚えた<small>間隔をあける</small></button>
    </div>`;
}
function isCorrect(input, candidates) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const a = norm(input);
  if (!a) return false;
  return candidates.some(c => norm(c) === a);
}
function renderDone() {
  current = null;
  const area = document.getElementById('cardArea');
  if (drillMode) { renderDrillDone(area); return; }
  if (!ITEMS.length) {
    area.innerHTML = `
      <div class="empty">
        <div class="big">📭</div>
        <div>カードがまだありません</div>
        <p style="color:var(--muted);font-size:14px;margin-top:8px;">「登録」からフレーズを追加してください。</p>
        <button class="big-btn" style="margin-top:24px" onclick="goRegister()">フレーズを登録する</button>
        <button class="big-btn secondary" style="margin-top:10px" onclick="goHome()">ホームへ</button>
      </div>`;
    refreshTop();
    return;
  }
  const studied = todayStudiedIds().length;
  const label = studied ? '今日の単語をもう一周（おかわり）' : '自由に練習する';
  area.innerHTML = `
    <div class="empty">
      <div class="big">🎉</div>
      <div>今のセットは完了！</div>
      <p style="color:var(--muted);font-size:14px;margin-top:8px;">
        またあとで開くと、忘れかけた頃のカードが出てきます。</p>
      <button class="big-btn" style="margin-top:24px" onclick="goExtra()">${label}</button>
      <button class="big-btn secondary" style="margin-top:10px" onclick="goHome()">ホームへ</button>
    </div>`;
  refreshTop();
}

function renderDrillDone(area) {
  if (drillMode === 'review') { renderReviewDone(area); return; }
  const s = drillSummary();
  // このセッションでパックを終わらせたか（終わらせると currentPackNo が次へ動く）
  const cleared = drillPackNo && s.pack !== drillPackNo;
  const total = cleared ? packItems(drillPackNo).length : s.total;
  const done = cleared ? total : s.done;
  const pct = total ? Math.round(done / total * 100) : 0;
  let msg;
  if (cleared && s.pack) {
    msg = `次は「${esc(packTitle(s.pack))}」が開きました。ホームから始められます。`;
  } else if (cleared) {
    msg = '用意してあるパックはこれで全部です。新しいパックは準備中。復習で回し続けてください。';
  } else {
    msg = '明日また開くと、連続日数の続きが積み上がります。';
  }
  area.innerHTML = `
    <div class="empty">
      <div class="big">${cleared ? '🏆' : '✅'}</div>
      <div>${cleared ? `「${esc(packTitle(drillPackNo))}」${total}文すべて卒業！` : '今日の分は終わり'}</div>
      <p style="color:var(--muted);font-size:14px;margin-top:8px;">
        卒業 ${done}/${total} 文。${msg}</p>
      <div class="bar" style="margin:16px auto;max-width:280px"><span style="width:${pct}%"></span></div>
      ${cleared ? '' : `<button class="big-btn" style="margin-top:16px" onclick="goDrillExtra()">もう一周する（おかわり）</button>`}
      <button class="big-btn${cleared ? '' : ' secondary'}" style="margin-top:${cleared ? 16 : 10}px" onclick="goHome()">ホームへ</button>
    </div>`;
  refreshTop();
}

function renderReviewDone(area) {
  const n = graduatedIds().length;
  area.innerHTML = `
    <div class="empty">
      <div class="big">🎉</div>
      <div>復習を一周しました</div>
      <p style="color:var(--muted);font-size:14px;margin-top:8px;">
        卒業ずみ ${n} 文。何度でも回せます。</p>
      <button class="big-btn" style="margin-top:24px" onclick="startReview()">もう一周する</button>
      <button class="big-btn secondary" style="margin-top:10px" onclick="goHome()">ホームへ</button>
    </div>`;
  refreshTop();
}

/* ---------- ホーム ---------- */
function renderVoiceUI() {
  refreshVoices();
  const sel = document.getElementById('voiceSelect');
  if (!sel) return;
  const en = englishVoices();
  if (!en.length) {
    sel.innerHTML = '<option>（この端末で英語音声が見つかりません）</option>';
    return;
  }
  const cur = currentVoiceName();
  sel.innerHTML = en.map(v =>
    `<option value="${esc(v.name)}"${v.name === cur ? ' selected' : ''}>${esc(v.name + ' (' + v.lang + ')')}</option>`
  ).join('');
  const rate = document.getElementById('rateRange');
  const rateVal = document.getElementById('rateVal');
  rate.value = String(speechRate);
  rateVal.textContent = Number(speechRate).toFixed(2);
  sel.onchange = () => {
    localStorage.setItem(VOICE_KEY, sel.value);
    speak('This is the voice for your phrase cards.');
  };
  rate.oninput = () => {
    speechRate = parseFloat(rate.value);
    rateVal.textContent = speechRate.toFixed(2);
    localStorage.setItem(RATE_KEY, String(speechRate));
  };
  document.getElementById('voiceTestBtn').onclick =
    () => speak('It’s been a while. Have you tried peaches from Yamanashi?');
}

function renderDrillHome() {
  const box = document.getElementById('drillBox');
  if (!box) return;
  const s = drillSummary();
  if (!s.coreTotal) { box.hidden = true; renderReviewHome(s); return; }
  box.hidden = false;

  const title = document.getElementById('drillTitle');
  const start = document.getElementById('startDrillBtn');
  const pickBtn = document.getElementById('drillPickBtn');

  if (!s.pack) {
    // 用意してあるパックを全部卒業した状態。
    title.textContent = `パック${s.packCount}まで卒業`;
    document.getElementById('drillCount').textContent = `${s.graduated} 文`;
    document.getElementById('drillBar').style.width = '100%';
    document.getElementById('drillHint').textContent =
      '新しいパックは準備中です。下の復習で回し続けてください。';
    start.hidden = true;
    pickBtn.hidden = false;
  } else {
    const pct = s.total ? Math.round(s.done / s.total * 100) : 0;
    title.textContent = `パック${s.packIndex} ${s.title}`;
    document.getElementById('drillCount').textContent = `卒業 ${s.done}/${s.total}`;
    document.getElementById('drillBar').style.width = pct + '%';
    document.getElementById('drillHint').textContent = s.remaining
      ? `今日やる分が ${s.remaining} 文あります。言えるまで何度でも出てきます。`
      : `今日の分は終わりました。今日クリア ${s.clearedToday}/${s.total} 文。`;
    start.hidden = false;
    start.textContent = s.remaining
      ? `${s.total}文をやる（今日 ${s.remaining} 文）`
      : `${s.total}文をもう一周する`;
    pickBtn.hidden = false;
  }
  document.getElementById('drillPick').innerHTML = '';
  renderReviewHome(s);
}

// 卒業した文を貯めておく箱。パックをまたいで、いつでも全部やれる。
function renderReviewHome(s) {
  const box = document.getElementById('reviewBox');
  if (!box) return;
  const n = s.graduated;
  if (!n) { box.hidden = true; return; }
  box.hidden = false;
  document.getElementById('reviewCount').textContent = `${n} 文`;
  document.getElementById('reviewHint').textContent =
    `これまでに卒業した ${n} 文を、パックをまたいでランダムに全部出します。`;
  document.getElementById('startReviewBtn').textContent = `復習する（${n}文）`;
}

// レッスン直前に「今日はこれを使う」と決めるための3文。
function renderDrillPick() {
  const zone = document.getElementById('drillPick');
  const three = pickThreeForToday();
  if (!three.length) { zone.innerHTML = ''; return; }
  zone.innerHTML = `
    <div class="pick-card">
      <h4>今日のレッスンで、この3文を必ず使う</h4>
      ${three.map(it => `
        <div class="pick-row">
          <div class="pick-en">${esc(it.en[0])}</div>
          <div class="pick-ja">${esc(it.ja)}</div>
        </div>`).join('')}
      <button class="link-btn" id="pickCopyBtn">3文をコピーする</button>
      <p class="hint">レッスンが終わったら、先生のメモにこの3文が出てきたか見てください。
        また書かれていたら、まだ身についていないということです。</p>
    </div>`;
  document.getElementById('pickCopyBtn').onclick = () => {
    const ok = copyTextSync(three.map(it => `${it.en[0]}  （${it.ja}）`).join('\n'));
    toast(ok ? '3文をコピーしました' : 'コピーできませんでした');
  };
}

function renderHome() {
  refreshTop();
  renderVoiceUI();
  renderDrillHome();

  const themes = {};
  for (const it of ITEMS) {
    if (it.theme === CORE_THEME) continue;   // 専用の枠が上にあるので重複させない
    const t = it.theme || 'その他';
    themes[t] = themes[t] || { total: 0, learned: 0 };
    themes[t].total++;
    const s = srs[it.id];
    if (s && s.box >= 3) themes[t].learned++;
  }
  const tl = document.getElementById('themeList');
  tl.innerHTML = Object.entries(themes).map(([t, v]) => `
    <button class="theme-card" data-theme="${esc(t)}">
      <span>${esc(t)}</span>
      <span class="meta">${v.learned}/${v.total} 定着</span>
    </button>`).join('');
  tl.querySelectorAll('.theme-card').forEach(b => {
    b.onclick = () => startSession(b.dataset.theme);
  });

  const total = ITEMS.length;
  const seen = Object.keys(srs).length;
  const learned = Object.values(srs).filter(s => s.box >= 3).length;
  const pct = total ? Math.round(learned / total * 100) : 0;
  document.getElementById('statsBox').innerHTML = `
    全 ${total} 件中<br>学習開始: ${seen} 件<br>
    定着(箱3以上): ${learned} 件 (${pct}%)
    <div class="bar"><span style="width:${pct}%"></span></div>`;

  const keyInput = document.getElementById('apiKeyInput');
  keyInput.value = getApiKey();
  keyInput.onchange = () => setApiKey(keyInput.value.trim());
}

/* ---------- 学習の記録（グラフ） ---------- */
let statsDays = 14;   // 14 | 30

function isoOf(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 今日から過去 n 日分の系列(古い→新しい)
function dailySeries(n) {
  const base = todayStart();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const t = base - i * DAY;
    const d = new Date(t);
    const rec = daily[isoOf(t)] || { reviews: 0, ms: 0 };
    out.push({
      t,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      dow: d.getDay(),
      reviews: rec.reviews,
      min: rec.ms / 60000,
    });
  }
  return out;
}

// 1本の棒グラフ。values は数値配列。fmt は棒上のラベル整形。
function barChartHtml(title, series, getVal, fmt, color) {
  const vals = series.map(getVal);
  const max = Math.max(1, ...vals);
  const showNums = series.length <= 14;
  const cols = series.map((d, i) => {
    const v = vals[i];
    const h = v > 0 ? Math.max(4, Math.round(v / max * 100)) : 0;
    const today = i === series.length - 1;
    const weekend = d.dow === 0 || d.dow === 6;
    const numHtml = showNums ? `<div class="cbar-num">${v > 0 ? fmt(v) : ''}</div>` : '';
    const lab = showNums || i % 5 === 0 ? d.label : '';
    return `<div class="cbar-col${today ? ' today' : ''}">
        ${numHtml}
        <div class="cbar-track"><div class="cbar" style="height:${h}%;background:${v > 0 ? color : 'var(--panel2)'}"></div></div>
        <div class="cbar-x${weekend ? ' we' : ''}">${lab}</div>
      </div>`;
  }).join('');
  return `<div class="chart">
      <div class="chart-title">${title}</div>
      <div class="chart-bars">${cols}</div>
    </div>`;
}

function goStats() {
  showView('statsView');
  renderStats();
}

function renderStats() {
  document.querySelectorAll('#statsRangeSwitch button').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.days) === statsDays));
  const area = document.getElementById('statsArea');
  const series = dailySeries(statsDays);
  const totalRev = series.reduce((a, d) => a + d.reviews, 0);
  const totalMin = series.reduce((a, d) => a + d.min, 0);
  const activeDays = series.filter(d => d.reviews > 0).length;

  if (totalRev === 0) {
    area.innerHTML = `<div class="empty">
        <div class="big">📊</div>
        <div>まだ記録がありません</div>
        <p style="color:var(--muted);font-size:14px;margin-top:8px;">
          学習すると、その日から日別の回数と時間がここに貯まります。</p>
      </div>`;
    return;
  }

  const fmtMin = m => m >= 1 ? String(Math.round(m)) : (m > 0 ? '·' : '');
  area.innerHTML = `
    <div class="stats-summary">
      <div class="ss-item"><span class="ss-num">${totalRev}</span><span class="ss-lab">回</span></div>
      <div class="ss-item"><span class="ss-num">${Math.round(totalMin)}</span><span class="ss-lab">分</span></div>
      <div class="ss-item"><span class="ss-num">${activeDays}</span><span class="ss-lab">日</span></div>
    </div>
    <p class="hint">直近 ${statsDays} 日の合計（回数 / 学習時間 / 学習した日数）</p>
    ${barChartHtml('日別 回数（回）', series, d => d.reviews, v => String(v), 'var(--accent)')}
    ${barChartHtml('日別 学習時間（分）', series, d => d.min, fmtMin, 'var(--good)')}`;
}

/* ---------- 一覧（ながめる用） ---------- */
const LIST_PAGE_SIZE = 10;
let listMode = 'recent';    // 'recent' | 'group'
let listPage = 0;

function goList() {
  showView('listView');
  listMode = 'recent';
  listPage = 0;
  renderList();
}

function goStar() {
  showView('listView');
  listMode = 'star';
  listPage = 0;
  renderList();
}

function renderList() {
  document.querySelectorAll('#listModeSwitch button').forEach(b =>
    b.classList.toggle('active', b.dataset.listmode === listMode));
  if (listMode === 'group') renderListGroup();
  else if (listMode === 'star') renderListStar();
  else renderListRecent();
}

function emptyListHtml() {
  return `<div class="empty"><div class="big">📭</div><div>まだフレーズがありません</div></div>`;
}

// 1行: 英語(main) + 日本語 のみ。タップで lr-detail を開く。
function listRowHtml(it) {
  const main = (it.en && it.en[0]) || '';
  return `
    <div class="list-row" data-id="${esc(it.id)}">
      <div class="lr-head">
        <button class="spk" data-en="${esc(main)}">🔊</button>
        <div class="lr-text">
          <div class="lr-en">${esc(main)}</div>
          <div class="lr-ja">${esc(it.ja)}</div>
        </div>
        ${starBtnHtml(it.id)}
      </div>
      <div class="lr-detail" hidden></div>
    </div>`;
}

function listDetailHtml(it) {
  const alts = (it.en || []).slice(1).map(a => `<div class="alt">= ${esc(a)}</div>`).join('');
  return `
    ${alts}
    ${it.advice_ja ? `<div class="advice">💡 ${esc(it.advice_ja)}</div>` : ''}
    <div class="lr-meta">${esc(it.theme)} ・ ${it.type === 'word' ? '単語' : 'フレーズ'} ・ 難易度${it.difficulty || 1}</div>`;
}

function wireListRows(container) {
  container.querySelectorAll('.list-row').forEach(row => {
    const it = BY_ID[row.dataset.id];
    if (!it) return;
    const detail = row.querySelector('.lr-detail');
    row.querySelector('.lr-head').onclick = () => {
      if (detail.hidden) {
        detail.innerHTML = listDetailHtml(it);
        detail.hidden = false;
        row.classList.add('open');
      } else {
        detail.hidden = true;
        row.classList.remove('open');
      }
    };
    const spk = row.querySelector('.spk');
    spk.onclick = (e) => { e.stopPropagation(); speak(spk.dataset.en); };
    const star = row.querySelector('.star-btn');
    if (star) wireStarBtn(star, () => { if (listMode === 'star') renderList(); });
  });
}

// 新しい順の配列を 10件ずつページ送りで描画（最新順 / ★だけ で共用）
function renderListPaged(all) {
  const area = document.getElementById('listArea');
  const pages = Math.max(1, Math.ceil(all.length / LIST_PAGE_SIZE));
  listPage = Math.min(Math.max(0, listPage), pages - 1);
  const start = listPage * LIST_PAGE_SIZE;
  const slice = all.slice(start, start + LIST_PAGE_SIZE);
  area.innerHTML =
    slice.map(listRowHtml).join('') +
    `<div class="pager">
       <button class="pg-btn" id="pgPrev"${listPage === 0 ? ' disabled' : ''}>← 前の10件</button>
       <span class="pg-pos">${listPage + 1} / ${pages}（全${all.length}件）</span>
       <button class="pg-btn" id="pgNext"${listPage >= pages - 1 ? ' disabled' : ''}>次の10件 →</button>
     </div>`;
  wireListRows(area);
  const prev = document.getElementById('pgPrev');
  const next = document.getElementById('pgNext');
  if (prev) prev.onclick = () => { listPage--; renderList(); window.scrollTo(0, 0); };
  if (next) next.onclick = () => { listPage++; renderList(); window.scrollTo(0, 0); };
}

// 最新順（ITEMS は末尾が最新）
function renderListRecent() {
  const all = ITEMS.slice().reverse();
  if (!all.length) { document.getElementById('listArea').innerHTML = emptyListHtml(); return; }
  renderListPaged(all);
}

// ★を付けたものだけ（新しい順）
function renderListStar() {
  const all = ITEMS.filter(it => isStarred(it.id)).reverse();
  if (!all.length) {
    document.getElementById('listArea').innerHTML =
      `<div class="empty">
         <div class="big">☆</div>
         <div>★を付けたフレーズがありません</div>
         <p style="font-size:14px;margin-top:8px;">一覧やカードの ☆ をタップすると、ここに集まります。</p>
       </div>`;
    return;
  }
  renderListPaged(all);
}

// テーマごと（各グループ内も新しい順）。見出しタップで開閉。
function renderListGroup() {
  const area = document.getElementById('listArea');
  if (!ITEMS.length) { area.innerHTML = emptyListHtml(); return; }
  const groups = {};
  for (const it of ITEMS) {
    const t = it.theme || 'その他';
    (groups[t] = groups[t] || []).push(it);
  }
  const order = THEMES.filter(t => groups[t])
    .concat(Object.keys(groups).filter(t => !THEMES.includes(t)));
  area.innerHTML = order.map(t => {
    const rows = groups[t].slice().reverse().map(listRowHtml).join('');
    return `
      <div class="list-group">
        <button class="lg-head" data-theme="${esc(t)}">
          <span>${esc(t)}</span>
          <span class="lg-count">${groups[t].length}件 ▾</span>
        </button>
        <div class="lg-body" hidden>${rows}</div>
      </div>`;
  }).join('');
  area.querySelectorAll('.lg-head').forEach(h => {
    h.onclick = () => {
      const body = h.nextElementSibling;
      const open = body.hidden;
      body.hidden = !open;
      h.classList.toggle('open', open);
    };
  });
  wireListRows(area);
}

/* ---------- 登録 (Claude API でエンリッチ) ---------- */
function splitInput(raw) {
  // ｜(全角) と |(半角) と改行で分割
  return raw.replace(/\n/g, '|').split(/[|｜]/).map(s => s.trim()).filter(Boolean);
}

// 1つの入力欄を「単語」「フレーズ」見出しで振り分ける。
// 見出しが無いときは全体をフレーズ扱い。
function parseCombined(raw) {
  const buf = { words: [], phrases: [] };
  let section = 'phrases';
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (/^(単語|words?)[ 　]*[:：]?$/i.test(t)) { section = 'words'; continue; }
    if (/^(フレーズ|phrases?)[ 　]*[:：]?$/i.test(t)) { section = 'phrases'; continue; }
    buf[section].push(...splitInput(t));
  }
  return buf;
}
function slugify(text) {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 40) || 'item';
}
function normEn(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
}

const ENRICH_TOOL = {
  name: 'save_items',
  description: '英語の単語・フレーズを学習カード用に構造化して返す',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            en: { type: 'array', items: { type: 'string' },
              description: '英語表現。先頭は入力された表現を一字一句そのまま。'
                + "'/' や '(...)' で入力に書かれた言い換え・補足だけを完全な形に展開して2番目以降に加える。"
                + '入力に無い言い換えを作って加えない。' },
            ja: { type: 'string', description: '自然な日本語訳' },
            situation_ja: { type: 'string', description: 'この表現が出てくる具体的な場面(日本語, 30字以内目安)' },
            theme: { type: 'string', enum: THEMES, description: "最も近いテーマ。なければ '一般表現'。" },
            difficulty: { type: 'integer', minimum: 1, maximum: 3, description: '1=易 2=中 3=難' },
            advice_ja: { type: 'string',
              description: '覚える/使うためのアドバイス(日本語, 60〜130字)。'
                + '前半に文法・語法の要点や「一般的には〜とも言う」という言い換えの紹介、'
                + '後半に「この後こう続けると会話が伸びる」という'
                + '具体的な一言を英文＋日本語訳で必ず入れる。'
                + '例: 続けて It was better than I expected.(思ったよりよかった) と足す。'
                + '他のカードを番号で指さず、英文そのものを書くこと。' },
            related_hint: { type: 'array', items: { type: 'string' },
              description: 'この表現と関連が深い他の英語表現(英文そのまま)。' },
          },
          required: ['en', 'ja', 'situation_ja', 'theme', 'difficulty', 'advice_ja'],
        },
      },
    },
    required: ['items'],
  },
};

const SYSTEM_PROMPT =
  'あなたは日本人英語学習者のための教材エディタです。与えられた英単語・英フレーズを単語帳カード用に構造化します。' +
  '入力された表現は本人が英会話レッスンで実際に教わったものです。en 配列の先頭には入力の表現を一字一句そのまま置き、' +
  '別の言い方に書き換えたり、より自然な形に直したり、順番を入れ替えたりしないでください。' +
  "'/' や '(...)' で入力に示された言い換え・補足だけは、意味を保って自然な完全文/句に展開し2番目以降に入れてください。" +
  '「一般的にはこう言う」という言い換えの紹介や、続け方の提案は advice_ja に書きます。' +
  '翻訳は直訳すぎず自然に。situation_ja はその表現を実際に使う場面を簡潔に。';

async function callAnthropic(apiKey, words, phrases) {
  const payload = { words, phrases, themes: THEMES };
  const user =
    '次の単語(words)とフレーズ(phrases)をカード化してください。' +
    'words は type=word、phrases は type=phrase として扱える形で、入力された順に items を返してください。\n\n' +
    JSON.stringify(payload, null, 2);
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: [ENRICH_TOOL],
      tool_choice: { type: 'tool', name: 'save_items' },
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch {}
    throw new Error(`API ${res.status} ${detail}`);
  }
  const json = await res.json();
  const block = (json.content || []).find(b => b.type === 'tool_use' && b.name === 'save_items');
  if (!block) throw new Error('構造化結果が返りませんでした');
  const items = block.input.items;
  if (!items || !items.length) {
    // 出力上限で途中で切れた等
    throw new Error(`結果を受け取れませんでした (stop_reason=${json.stop_reason})。一度に入れる件数を減らしてください。`);
  }
  return items;
}

function todayISO() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function finalizeItems(rawItems, nWords) {
  // 既存(ITEMS)に加えて、まだ保存していないプレビュー分(pendingItems)とも
  // ID衝突・関連付けが噛み合うようにする(「1つずつ」で積むため)。
  const prior = ITEMS.concat(pendingItems || []);
  const used = new Set(prior.map(it => it.id));
  const enIndex = {};
  prior.forEach(it => (it.en || []).forEach(e => { enIndex[normEn(e)] = it.id; }));

  const out = rawItems.map((it, i) => {
    const type = i < nWords ? 'word' : 'phrase';
    const prefix = type === 'word' ? 'w' : 'p';
    let base = `${prefix}-${slugify((it.en && it.en[0]) || 'item')}`;
    let id = base, n = 2;
    while (used.has(id)) { id = `${base}-${n}`; n++; }
    used.add(id);
    (it.en || []).forEach(e => { if (!(normEn(e) in enIndex)) enIndex[normEn(e)] = id; });
    return { ...it, id, type };
  });

  out.forEach(it => {
    const related = [];
    for (const hint of (it.related_hint || [])) {
      const rid = enIndex[normEn(hint)];
      if (rid && rid !== it.id && !related.includes(rid)) related.push(rid);
    }
    delete it.related_hint;
    it.related = related;
    it.added = todayISO();
    if (!Array.isArray(it.en)) it.en = [String(it.en)];
  });
  return out;
}

let pendingItems = null;

async function runEnrich() {
  const status = document.getElementById('registerStatus');
  const apiKey = getApiKey();
  if (!apiKey) {
    status.className = 'status err';
    status.textContent = 'ホーム → 設定 で Anthropic APIキーを入れてください。';
    return;
  }
  const { words, phrases } = parseCombined(document.getElementById('comboInput').value);
  if (!words.length && !phrases.length) {
    status.className = 'status err';
    status.textContent = '単語かフレーズを入力してください。';
    return;
  }
  status.className = 'status';
  status.textContent = `Claude (${MODEL}) で ${words.length + phrases.length} 件をエンリッチ中…`;
  document.getElementById('enrichBtn').disabled = true;
  // まとめて貼り付けは置き換え。既存のプレビューはクリアしてから生成。
  pendingItems = null;
  try {
    const raw = await callAnthropic(apiKey, words, phrases);
    pendingItems = finalizeItems(raw, words.length);
    status.className = 'status ok';
    status.textContent = `${pendingItems.length} 件を生成しました。内容を確認して保存してください。`;
    renderPreview();
  } catch (e) {
    status.className = 'status err';
    status.textContent = 'エラー: ' + e.message;
  } finally {
    document.getElementById('enrichBtn').disabled = false;
  }
}

/* 「1つずつ」モード: 種類を選んで英語を1件入力 → エンリッチして
   プレビュー(pendingItems)に積む。続けて入力できる。 */
let singleType = 'word';

async function runSingleEnrich() {
  const status = document.getElementById('registerStatus');
  const apiKey = getApiKey();
  if (!apiKey) {
    status.className = 'status err';
    status.textContent = 'ホーム → 設定 で Anthropic APIキーを入れてください。';
    return;
  }
  const input = document.getElementById('singleInput');
  const val = input.value.trim();
  if (!val) {
    status.className = 'status err';
    status.textContent = '単語かフレーズを入力してください。';
    return;
  }
  const words = singleType === 'word' ? [val] : [];
  const phrases = singleType === 'phrase' ? [val] : [];
  status.className = 'status';
  status.textContent = `Claude (${MODEL}) でエンリッチ中…`;
  const btn = document.getElementById('singleAddBtn');
  btn.disabled = true;
  try {
    const raw = await callAnthropic(apiKey, words, phrases);
    const items = finalizeItems(raw, words.length);
    pendingItems = (pendingItems || []).concat(items);
    status.className = 'status ok';
    status.textContent = `追加しました（プレビュー ${pendingItems.length} 件）。続けて入力するか、下で保存してください。`;
    input.value = '';
    input.focus();
    renderPreview();
  } catch (e) {
    status.className = 'status err';
    status.textContent = 'エラー: ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

function setRegMode(m) {
  document.querySelectorAll('#regModeSwitch button').forEach(b =>
    b.classList.toggle('active', b.dataset.regmode === m));
  document.getElementById('comboPanel').hidden = (m !== 'combo');
  document.getElementById('singlePanel').hidden = (m !== 'single');
}

function renderPreview() {
  const area = document.getElementById('previewArea');
  if (!pendingItems || !pendingItems.length) { area.innerHTML = ''; return; }
  area.innerHTML = pendingItems.map(it => `
    <div class="preview-card">
      <div class="pc-head">${it.type === 'word' ? '単語' : 'フレーズ'} ・ ${esc(it.theme)} ・ 難易度${it.difficulty}</div>
      <div class="pc-en">${esc(it.en.join(' / '))}</div>
      <div class="pc-ja">${esc(it.ja)}</div>
      <div class="pc-sit">場面: ${esc(it.situation_ja)}</div>
      <div class="pc-adv">💡 ${esc(it.advice_ja || '')}</div>
    </div>`).join('') +
    `<button class="big-btn" id="saveItemsBtn">この内容で保存（端末内）</button>`;
  document.getElementById('saveItemsBtn').onclick = saveItems;
}

function saveItems() {
  if (!pendingItems || !pendingItems.length) return;
  DECK = DECK.concat(pendingItems);
  saveDeck();
  rebuildItems();
  pendingItems = null;
  document.getElementById('comboInput').value = '';
  document.getElementById('previewArea').innerHTML = '';
  const status = document.getElementById('registerStatus');
  status.className = 'status ok';
  status.textContent = `保存しました。合計 ${ITEMS.length} 件。`;
  document.getElementById('verLine').textContent =
    `収録 ${ITEMS.length} 件（うち追加 ${DECK.length} 件）`;
}

/* ---------- セッション/遷移 ---------- */
function startSession(theme) {
  drillMode = false;
  sessionTheme = theme || null;
  queue = buildQueue(sessionTheme);
  showView('studyView');
  if (!queue.length) { renderDone(); return; }
  nextCard();
}

function startExtra() {
  drillMode = false;
  queue = buildExtraQueue(sessionTheme);
  showView('studyView');
  if (!queue.length) { renderDone(); return; }
  nextCard();
}

function startDrill() {
  const no = currentPackNo();
  if (!no) return;
  drillMode = 'pack';
  drillPackNo = no;
  sessionTheme = CORE_THEME;
  queue = buildDrillQueue(no);
  showView('studyView');
  if (!queue.length) { renderDone(); return; }
  nextCard();
}
function goDrillExtra() {
  const no = drillPackNo || currentPackNo();
  if (!no) return;
  drillMode = 'pack';
  drillPackNo = no;
  queue = buildDrillExtraQueue(no);
  showView('studyView');
  if (!queue.length) { renderDone(); return; }
  nextCard();
}
function startReview() {
  drillMode = 'review';
  drillPackNo = 0;
  sessionTheme = CORE_THEME;
  queue = buildReviewQueue();
  showView('studyView');
  if (!queue.length) { renderDone(); return; }
  nextCard();
}
function goHome() { drillMode = false; drillPackNo = 0; showView('homeView'); renderHome(); }
function goRegister() {
  showView('registerView');
  pendingItems = null;
  document.getElementById('registerStatus').textContent = '';
  document.getElementById('registerStatus').className = 'status';
  document.getElementById('previewArea').innerHTML = '';
  const si = document.getElementById('singleInput');
  if (si) si.value = '';
}

/* ---------- ユーティリティ ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------- バックアップ / 復元 ---------- */
// フレーズ(DECK)と進捗(srs)と音声設定をまとめる。APIキーは含めない。
function buildBackup() {
  return {
    app: 'phrasedeck',
    version: 1,
    exportedAt: new Date().toISOString(),
    deck: DECK,
    srs: srs,
    stars: [...STARS],
    daily: daily,
    settings: {
      voice: localStorage.getItem(VOICE_KEY) || '',
      rate: localStorage.getItem(RATE_KEY) || '',
    },
  };
}

// iPhone では共有シート(→「ファイルに保存」で iCloud Drive)に出す。
// 非対応環境ではダウンロードにフォールバック。
async function doBackup() {
  const text = JSON.stringify(buildBackup(), null, 2);
  const fname = `phrasedeck-backup-${todayISO()}.json`;
  const file = new File([text], fname, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'フレーズデッキ バックアップ' }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; /* それ以外は下へ */ }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// バックアップ(または Mac の phrases.json)を適用。今の内容に上書き。
function applyBackup(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('壊れたファイルです');
  const deck = Array.isArray(obj.deck) ? obj.deck
    : (Array.isArray(obj.items) ? obj.items
      : (Array.isArray(obj) ? obj : null));
  if (!Array.isArray(deck)) throw new Error('フレーズが見つかりませんでした');
  DECK = deck; saveDeck();
  if (obj.srs && typeof obj.srs === 'object') { srs = obj.srs; saveSrs(); }
  if (Array.isArray(obj.stars)) { STARS = new Set(obj.stars); saveStars(); }
  if (obj.daily && typeof obj.daily === 'object') { daily = obj.daily; saveDaily(); }
  if (obj.settings) {
    if (obj.settings.voice) localStorage.setItem(VOICE_KEY, obj.settings.voice);
    if (obj.settings.rate) { localStorage.setItem(RATE_KEY, obj.settings.rate); speechRate = parseFloat(obj.settings.rate) || speechRate; }
  }
  // 復元後はシードのマイグレーションを走らせない
  localStorage.setItem('phrasedeck.migrated.v1', '1');
  rebuildItems();
  return DECK.length;
}

function goRestore() {
  const f = document.getElementById('restoreFile');
  if (f) { f.value = ''; f.click(); }
}

function handleRestoreFile(file) {
  if (!file) return;
  if (!confirm('今の内容を、選んだバックアップで置き換えます。よろしいですか？')) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const obj = JSON.parse(String(reader.result));
      const n = applyBackup(obj);
      goHome();
      alert(`復元しました。フレーズ ${n} 件。`);
    } catch (e) { alert('復元エラー: ' + e.message); }
  };
  reader.onerror = () => alert('ファイルを読めませんでした。');
  reader.readAsText(file);
}

/* ---------- 初期化 ---------- */
async function init() {
  loadSrs();
  loadStars();
  loadDaily();
  loadDrill();
  await loadData();

  document.querySelectorAll('#modeSwitch button').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('#modeSwitch button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      mode = b.dataset.mode;
      if (current) { revealed = false; renderCard(); }
    };
  });

  document.getElementById('homeBtn').onclick = goHome;
  document.getElementById('startDrillBtn').onclick = startDrill;
  document.getElementById('drillPickBtn').onclick = renderDrillPick;
  document.getElementById('startReviewBtn').onclick = startReview;
  document.getElementById('startTodayBtn').onclick = () => startSession(null);
  document.getElementById('goListBtn').onclick = goList;
  document.getElementById('goStarBtn').onclick = goStar;
  document.getElementById('goStatsBtn').onclick = goStats;
  document.querySelectorAll('#statsRangeSwitch button').forEach(b => {
    b.onclick = () => { statsDays = Number(b.dataset.days); renderStats(); };
  });
  document.getElementById('goRegisterBtn').onclick = goRegister;

  document.querySelectorAll('#listModeSwitch button').forEach(b => {
    b.onclick = () => { listMode = b.dataset.listmode; listPage = 0; renderList(); window.scrollTo(0, 0); };
  });
  document.getElementById('enrichBtn').onclick = runEnrich;

  // 登録の入力方法切り替え（まとめて貼り付け / 1つずつ）
  document.querySelectorAll('#regModeSwitch button').forEach(b => {
    b.onclick = () => setRegMode(b.dataset.regmode);
  });
  document.querySelectorAll('#singleTypeSwitch button').forEach(b => {
    b.onclick = () => {
      singleType = b.dataset.stype;
      document.querySelectorAll('#singleTypeSwitch button').forEach(x =>
        x.classList.toggle('active', x === b));
    };
  });
  document.getElementById('singleAddBtn').onclick = runSingleEnrich;
  document.getElementById('singleInput').onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); runSingleEnrich(); }
  };
  document.getElementById('backupBtn').onclick = doBackup;
  document.getElementById('restoreBtn').onclick = goRestore;
  document.getElementById('restoreFile').onchange = (e) => handleRestoreFile(e.target.files[0]);
  document.getElementById('resetBtn').onclick = () => {
    if (confirm('学習の進捗をすべて消します。よろしいですか？（登録したフレーズは消えません）')) {
      srs = {}; saveSrs(); renderHome();
    }
  };

  const muteBtn = document.getElementById('muteBtn');
  if (muteBtn) {
    muteBtn.onclick = () => {
      muted = !muted;
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
      if (muted && 'speechSynthesis' in window) window.speechSynthesis.cancel();
      renderMuteBtn();
    };
    renderMuteBtn();
  }

  if ('speechSynthesis' in window) {
    refreshVoices();
    window.speechSynthesis.onvoiceschanged = () => {
      refreshVoices();
      if (document.getElementById('homeView').classList.contains('active')) renderVoiceUI();
    };
  }

  goHome();

  if ('serviceWorker' in navigator) {
    // 新しい SW が制御を取ったら自動で読み直す (更新を即反映)
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
    // updateViaCache:'none' で sw.js を毎回ネットから取得 → 更新検知を確実に
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then(reg => reg.update())
      .catch(() => {});
  }
}

window.goHome = goHome;
window.goExtra = startExtra;
window.goRegister = goRegister;
init();
