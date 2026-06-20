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

// エンリッチに使うモデル。コスト重視で Sonnet。品質優先なら 'claude-opus-4-8'。
const MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const DAY = 86400000;
const BOX_INTERVALS = [0, 1, 3, 7, 14, 30];
const NEW_PER_DAY = 8;
const MAX_BOX = BOX_INTERVALS.length - 1;

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
  let due = 0;
  for (const it of ITEMS) {
    const s = srs[it.id];
    if (s && s.due <= now) due++;
  }
  const newRoom = Math.max(0, NEW_PER_DAY - countNewToday());
  const newAvail = ITEMS.filter(it => !srs[it.id]).length;
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
  s.last = Date.now();
  srs[item.id] = s;
  saveSrs();
  if (g === 'again') queue.push(item.id);
}

/* ---------- 音声(TTS) ---------- */
const VOICE_KEY = 'phrasedeck.voice';
const RATE_KEY = 'phrasedeck.rate';
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

/* ---------- 画面遷移 ---------- */
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function refreshTop() {
  document.getElementById('dueCount').textContent = dueCountAll();
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

function renderCard() {
  const it = current;
  const area = document.getElementById('cardArea');
  const diffStars = '★'.repeat(it.difficulty || 1) + '☆'.repeat(3 - (it.difficulty || 1));
  area.innerHTML = `
    <div class="card">
      <span class="theme-tag">${esc(it.theme)}<span class="type-tag">${it.type === 'word' ? '単語' : 'フレーズ'}</span></span>
      <div class="difficulty">難易度 ${diffStars}</div>
      <div class="situation">${esc(it.situation_ja)}</div>
      <div class="prompt-ja">${esc(it.ja)}</div>
      <div id="answerZone"></div>
    </div>`;
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
    b.onclick = () => { grade(current, b.dataset.g); refreshTop(); nextCard(); };
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
          b.onclick = () => { grade(current, b.dataset.g); refreshTop(); nextCard(); };
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
    b.onclick = () => { grade(current, b.dataset.g); refreshTop(); nextCard(); };
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
    </div>`;
}
function wireReveal(zone) {
  const spk = zone.querySelector('.spk');
  if (spk) spk.onclick = (e) => { e.stopPropagation(); speak(spk.dataset.en); };
}
function gradeRowHtml() {
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
  area.innerHTML = `
    <div class="empty">
      <div class="big">🎉</div>
      <div>今のセットは完了！</div>
      <p style="color:var(--muted);font-size:14px;margin-top:8px;">
        またあとで開くと、忘れかけた頃のカードが出てきます。</p>
      <button class="big-btn" style="margin-top:24px" onclick="goHome()">ホームへ</button>
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

function renderHome() {
  refreshTop();
  renderVoiceUI();

  const themes = {};
  for (const it of ITEMS) {
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
              description: "英語表現。'/' や '(...)' の言い換えは配列で複数に分け、完全な形に整える。" },
            ja: { type: 'string', description: '自然な日本語訳' },
            situation_ja: { type: 'string', description: 'この表現が出てくる具体的な場面(日本語, 30字以内目安)' },
            theme: { type: 'string', enum: THEMES, description: "最も近いテーマ。なければ '一般表現'。" },
            difficulty: { type: 'integer', minimum: 1, maximum: 3, description: '1=易 2=中 3=難' },
            advice_ja: { type: 'string', description: '覚える/使うためのワンポイント文法・語法アドバイス(日本語)' },
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
  "'/' や '(...)' で示された言い換え・補足は意味を保って自然な完全文/句に展開し en 配列に分けて入れてください。" +
  '翻訳は直訳すぎず自然に。situation_ja はその表現を実際に使う場面を簡潔に。アドバイスは文法・語法のつまずきやすい点を一言で。';

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
      max_tokens: 4096,
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
  return block.input.items;
}

function todayISO() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function finalizeItems(rawItems, nWords) {
  const used = new Set(ITEMS.map(it => it.id));
  const enIndex = {};
  ITEMS.forEach(it => (it.en || []).forEach(e => { enIndex[normEn(e)] = it.id; }));

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
  queue = buildQueue(theme || null);
  showView('studyView');
  if (!queue.length) { renderDone(); return; }
  nextCard();
}
function goHome() { showView('homeView'); renderHome(); }
function goRegister() {
  showView('registerView');
  document.getElementById('registerStatus').textContent = '';
  document.getElementById('previewArea').innerHTML = '';
}

/* ---------- ユーティリティ ---------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------- 初期化 ---------- */
async function init() {
  loadSrs();
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
  document.getElementById('startTodayBtn').onclick = () => startSession(null);
  document.getElementById('goRegisterBtn').onclick = goRegister;
  document.getElementById('enrichBtn').onclick = runEnrich;
  document.getElementById('resetBtn').onclick = () => {
    if (confirm('学習の進捗をすべて消します。よろしいですか？（登録したフレーズは消えません）')) {
      srs = {}; saveSrs(); renderHome();
    }
  };

  if ('speechSynthesis' in window) {
    refreshVoices();
    window.speechSynthesis.onvoiceschanged = () => {
      refreshVoices();
      if (document.getElementById('homeView').classList.contains('active')) renderVoiceUI();
    };
  }

  goHome();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

window.goHome = goHome;
init();
