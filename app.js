const DB_NAME = 'flashcard-pwa-db';
const DB_VERSION = 2;
const CARD_STORE = 'cards';
const DECK_STORE = 'decks';
const DEFAULT_DECK_ID = 'default';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const DECK_COLORS = ['#2563eb', '#0d9488', '#7c3aed', '#ea580c', '#db2777', '#0284c7'];

let allDecks = [];
let allCards = [];
let activeDeckId = 'all';
let activeTag = 'all';
let formTargetDeckId = DEFAULT_DECK_ID;
let searchOpen = false;
let pendingLinkTargets = []; // [{ cardId, tag }]
let studyQueue = [];
let currentIndex = 0;
let showingBack = false;

// --- IndexedDB ---
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CARD_STORE)) {
        db.createObjectStore(CARD_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(DECK_STORE)) {
        db.createObjectStore(DECK_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllFromStore(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putToStore(storeName, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteFromStore(storeName, id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function parseTags(input) {
  if (Array.isArray(input)) {
    return [...new Set(input.map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean))];
  }
  return [
    ...new Set(
      String(input || '')
        .split(/[\s,、，]+/)
        .map((t) => t.trim().replace(/^#/, ''))
        .filter(Boolean)
    ),
  ];
}

function normalizeCard(raw) {
  const now = Date.now();
  return {
    id: raw.id || (crypto.randomUUID ? crypto.randomUUID() : String(now)),
    deckId: raw.deckId || DEFAULT_DECK_ID,
    front: String(raw.front || ''),
    back: String(raw.back || ''),
    note: raw.note ? String(raw.note) : '',
    tags: parseTags(raw.tags),
    reps: Number.isFinite(raw.reps) ? raw.reps : 0,
    interval: Number.isFinite(raw.interval) ? raw.interval : 0,
    ease: Number.isFinite(raw.ease) ? raw.ease : 2.5,
    dueAt: Number.isFinite(raw.dueAt) ? raw.dueAt : now,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
  };
}

async function ensureDefaultDeck() {
  const decks = await getAllFromStore(DECK_STORE);
  if (decks.length === 0) {
    await putToStore(DECK_STORE, {
      id: DEFAULT_DECK_ID,
      name: 'デフォルト',
      createdAt: Date.now(),
    });
  }
}

function getFallbackDeckId(excludeId = null) {
  const sorted = [...allDecks].sort((a, b) => a.createdAt - b.createdAt);
  const found = sorted.find((d) => d.id !== excludeId);
  return found ? found.id : DEFAULT_DECK_ID;
}

function getDeckName(deckId) {
  if (deckId === 'all') return 'すべての単語帳';
  const deck = allDecks.find((d) => d.id === deckId);
  if (deck) return deck.name;
  const fallback = allDecks[0];
  return fallback ? fallback.name : 'デフォルト';
}

function getAllUniqueTags(cards = allCards) {
  const set = new Set();
  for (const card of cards) {
    for (const tag of card.tags) set.add(tag);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
}

// --- 単語検索（#見出し語 タグ付け用） ---
function searchCardsForTag(query, excludeCardId = null, preferOtherDeckId = null) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return allCards
    .filter((c) => {
      if (excludeCardId && c.id === excludeCardId) return false;
      const hay = `${c.front} ${c.back} ${c.note} ${c.tags.join(' ')} ${getDeckName(c.deckId)}`.toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => {
      if (preferOtherDeckId) {
        const diff = Number(b.deckId !== preferOtherDeckId) - Number(a.deckId !== preferOtherDeckId);
        if (diff !== 0) return diff;
      }
      return b.updatedAt - a.updatedAt;
    })
    .slice(0, 6);
}

function renderPickerResults(containerEl, matches, onPick) {
  containerEl.innerHTML = '';
  if (!matches.length) {
    containerEl.classList.add('hidden');
    return;
  }
  for (const item of matches) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'picker-item';

    const left = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = item.front;
    const sub = document.createElement('div');
    sub.className = 'picker-item-sub';
    sub.textContent = item.back;
    left.append(strong, sub);

    const right = document.createElement('span');
    right.className = 'deck-pill';
    right.textContent = `${getDeckName(item.deckId)} → #${item.front}`;

    btn.append(left, right);
    btn.addEventListener('click', () => onPick(item));
    containerEl.appendChild(btn);
  }
  containerEl.classList.remove('hidden');
}

function renderPendingFormTags() {
  const wrap = document.getElementById('form-selected-tags');
  wrap.innerHTML = '';
  for (const item of pendingLinkTargets) {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.textContent = `#${item.tag}`;

    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '×';
    rm.setAttribute('aria-label', `${item.tag}を削除`);
    rm.addEventListener('click', () => {
      pendingLinkTargets = pendingLinkTargets.filter((x) => x.tag !== item.tag);
      renderPendingFormTags();
    });

    chip.appendChild(rm);
    wrap.appendChild(chip);
  }
}

async function linkCardWithTarget(card, targetCard) {
  const targetTag = targetCard.front.trim();
  const selfTag = card.front.trim();
  if (!targetTag || !selfTag) return;
  const now = Date.now();

  if (!card.tags.includes(targetTag)) {
    card.tags = parseTags([...card.tags, targetTag]);
    card.updatedAt = now;
    await putToStore(CARD_STORE, card);
  }

  if (!targetCard.tags.includes(selfTag)) {
    targetCard.tags = parseTags([...targetCard.tags, selfTag]);
    targetCard.updatedAt = now;
    await putToStore(CARD_STORE, targetCard);
  }
}

// --- 忘却曲線 (SM-2) ---
function computeSM2(card, quality, now = Date.now()) {
  const { reps, interval, ease } = card;

  if (quality === 1) {
    return {
      reps: 0,
      interval: 0,
      ease: Math.max(1.3, ease - 0.2),
      dueAt: now + RETRY_MS,
      label: '1分後',
    };
  }

  let nextInterval;
  let nextEase = ease;

  if (quality === 3) {
    nextInterval = reps === 0 ? 1 : Math.max(1, Math.round(interval * 1.2));
    nextEase = Math.max(1.3, ease - 0.15);
  } else if (quality === 4) {
    if (reps === 0) nextInterval = 1;
    else if (reps === 1) nextInterval = 6;
    else nextInterval = Math.round(interval * ease);
  } else {
    if (reps === 0) nextInterval = 4;
    else if (reps === 1) nextInterval = 10;
    else nextInterval = Math.round(interval * ease * 1.3);
    nextEase = ease + 0.15;
  }

  return {
    reps: reps + 1,
    interval: nextInterval,
    ease: Number(nextEase.toFixed(2)),
    dueAt: now + nextInterval * DAY_MS,
    label: formatDays(nextInterval),
  };
}

function formatDays(days) {
  if (days < 1) return '今日';
  if (days < 30) return `${days}日後`;
  const months = Math.round(days / 30);
  return `約${months}か月後`;
}

function formatDueBadge(card, now = Date.now()) {
  if (card.reps === 0 && card.interval === 0) return { text: '新規', isDue: true };
  const diff = card.dueAt - now;
  if (diff <= 0) return { text: '復習時期', isDue: true };
  if (diff < DAY_MS) {
    const hours = Math.max(1, Math.ceil(diff / (60 * 60 * 1000)));
    return { text: `${hours}時間後`, isDue: false };
  }
  const days = Math.ceil(diff / DAY_MS);
  return { text: formatDays(days), isDue: false };
}

// --- ページ切り替え ---
function showPage(pageId) {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  document.getElementById(pageId).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function setSubTab(tabName) {
  document.querySelectorAll('.sub-nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.subtab === tabName);
  });
  document.querySelectorAll('.sub-tab').forEach((t) => {
    t.classList.toggle('active', t.id === `subtab-${tabName}`);
  });
}

function setSearchOpen(open) {
  searchOpen = open;
  document.getElementById('deck-main-view').classList.toggle('hidden', open);
  document.getElementById('deck-search-view').classList.toggle('hidden', !open);
  document.getElementById('btn-toggle-search').classList.toggle('active', open);
  if (open) {
    renderCardList();
    document.getElementById('search-input').focus();
  }
}

function openDeckWorkspace(deckId, mode = 'study', tag = 'all') {
  activeDeckId = deckId;
  activeTag = tag;
  formTargetDeckId = deckId === 'all' ? getFallbackDeckId() : deckId;
  document.getElementById('active-deck-title').textContent = getDeckName(deckId);
  document.getElementById('add-msg').textContent = '';
  if (mode === 'search') {
    setSubTab('study');
    setSearchOpen(true);
  } else {
    setSearchOpen(false);
    setSubTab(mode);
  }
  renderWorkspace();
  showPage('page-deck');
}

// --- ホーム画面（横スクロール単語帳カルーセル） ---
function renderHomeCarousel() {
  const carousel = document.getElementById('deck-carousel');
  const dotsWrap = document.getElementById('carousel-dots');
  carousel.innerHTML = '';
  dotsWrap.innerHTML = '';

  const now = Date.now();
  const sortedDecks = [...allDecks].sort((a, b) => a.createdAt - b.createdAt);

  const items = [
    { id: 'all', name: 'すべての単語帳', kicker: 'ALL DECKS', isAll: true },
    ...sortedDecks.map((d, idx) => ({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      kicker: `DECK ${idx + 1}`,
      isAll: false,
    })),
  ];

  items.forEach((item, idx) => {
    const cards = item.isAll ? allCards : allCards.filter((c) => c.deckId === item.id);
    const dueCount = cards.filter((c) => c.dueAt <= now).length;
    const tags = getAllUniqueTags(cards).slice(0, 4);
    const color = DECK_COLORS[idx % DECK_COLORS.length];

    const cardEl = document.createElement('article');
    cardEl.className = 'deck-card';
    cardEl.style.setProperty('--deck-color', color);

    const top = document.createElement('div');
    top.className = 'deck-card-top';

    const titleWrap = document.createElement('div');
    titleWrap.style.flex = '1';
    titleWrap.style.minWidth = '0';
    const kicker = document.createElement('div');
    kicker.className = 'deck-card-kicker';
    kicker.textContent = item.kicker;

    const title = document.createElement('h2');
    title.className = 'deck-card-title';
    title.textContent = item.name;
    titleWrap.append(kicker, title);
    top.appendChild(titleWrap);

    if (!item.isAll) {
      const tools = document.createElement('div');
      tools.className = 'deck-card-tools';

      const renameBtn = document.createElement('button');
      renameBtn.type = 'button';
      renameBtn.className = 'btn-ghost';
      renameBtn.textContent = '名前変更';
      renameBtn.addEventListener('click', () => {
        if (titleWrap.querySelector('.deck-rename-form')) return;
        title.classList.add('hidden');
        const form = document.createElement('form');
        form.className = 'deck-rename-form';

        const input = document.createElement('input');
        input.type = 'text';
        input.value = item.name;
        input.required = true;

        const saveBtn = document.createElement('button');
        saveBtn.type = 'submit';
        saveBtn.className = 'btn-ghost';
        saveBtn.textContent = '保存';

        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const newName = input.value.trim();
          if (!newName) return;
          await putToStore(DECK_STORE, {
            id: item.id,
            name: newName,
            createdAt: item.createdAt,
          });
          await refreshAll();
        });

        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            form.remove();
            title.classList.remove('hidden');
          }
        });

        form.append(input, saveBtn);
        titleWrap.appendChild(form);
        input.focus();
        input.select();
      });
      tools.appendChild(renameBtn);

      if (sortedDecks.length > 1) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn-danger';
        delBtn.textContent = '削除';
        delBtn.addEventListener('click', async () => {
          const fallbackId = getFallbackDeckId(item.id);
          const fallbackName = getDeckName(fallbackId);
          if (!confirm(`単語帳「${item.name}」を削除しますか？（中の単語は「${fallbackName}」に移動します）`)) return;
          for (const c of allCards.filter((x) => x.deckId === item.id)) {
            c.deckId = fallbackId;
            await putToStore(CARD_STORE, c);
          }
          await deleteFromStore(DECK_STORE, item.id);
          await refreshAll();
        });
        tools.appendChild(delBtn);
      }

      top.appendChild(tools);
    }

    const stats = document.createElement('div');
    stats.className = 'deck-stats';

    const s1 = document.createElement('div');
    const s1Num = document.createElement('div');
    s1Num.className = 'deck-stat-num due';
    s1Num.textContent = String(dueCount);
    const s1Lbl = document.createElement('div');
    s1Lbl.className = 'deck-stat-label';
    s1Lbl.textContent = '今日の復習';
    s1.append(s1Num, s1Lbl);

    const s2 = document.createElement('div');
    const s2Num = document.createElement('div');
    s2Num.className = 'deck-stat-num';
    s2Num.textContent = String(cards.length);
    const s2Lbl = document.createElement('div');
    s2Lbl.className = 'deck-stat-label';
    s2Lbl.textContent = '総単語数';
    s2.append(s2Num, s2Lbl);

    stats.append(s1, s2);

    const tagsWrap = document.createElement('div');
    tagsWrap.className = 'deck-card-tags';
    for (const t of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = `#${t}`;
      tagsWrap.appendChild(chip);
    }

    const actions = document.createElement('div');
    actions.className = 'deck-card-actions';

    const studyBtn = document.createElement('button');
    studyBtn.type = 'button';
    studyBtn.className = 'btn btn-primary';
    studyBtn.style.background = color;
    studyBtn.textContent = '学習する';
    studyBtn.addEventListener('click', () => openDeckWorkspace(item.id, 'study'));

    const manageBtn = document.createElement('button');
    manageBtn.type = 'button';
    manageBtn.className = 'btn btn-subtle';
    manageBtn.textContent = '単語を追加';
    manageBtn.addEventListener('click', () => openDeckWorkspace(item.id, 'add'));

    actions.append(studyBtn, manageBtn);

    const middle = document.createElement('div');
    middle.append(stats, tagsWrap);
    cardEl.append(top, middle, actions);
    carousel.appendChild(cardEl);
  });

  // 末尾に「新しい単語帳」カード（ポップアップなしの直接入力UI）
  const newCard = document.createElement('article');
  newCard.className = 'deck-card deck-card-new';

  const newTitle = document.createElement('div');
  newTitle.style.fontWeight = '700';
  newTitle.style.color = 'var(--text)';
  newTitle.textContent = '新しい単語帳を作成';

  const newForm = document.createElement('form');
  newForm.className = 'new-deck-form';

  const newInput = document.createElement('input');
  newInput.type = 'text';
  newInput.placeholder = '単語帳の名前を入力';
  newInput.autocomplete = 'off';
  newInput.required = true;

  const newSubmit = document.createElement('button');
  newSubmit.type = 'submit';
  newSubmit.className = 'btn btn-primary';
  newSubmit.textContent = '作成';

  newForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = newInput.value.trim();
    if (!name) return;
    await createNewDeck(name);
  });

  newForm.append(newInput, newSubmit);
  newCard.append(newTitle, newForm);
  carousel.appendChild(newCard);

  // ページドット
  const totalSlides = items.length + 1;
  for (let i = 0; i < totalSlides; i++) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = `dot${i === 0 ? ' active' : ''}`;
    dot.setAttribute('aria-label', `${i + 1}番目の単語帳`);
    dot.addEventListener('click', () => {
      const target = carousel.children[i];
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    dotsWrap.appendChild(dot);
  }

  updateCarouselIndicator();

  // ホーム下部のタグショートカット
  const allTags = getAllUniqueTags();
  const homeTagsBox = document.getElementById('home-tags-box');
  const homeTagStrip = document.getElementById('home-tag-strip');
  homeTagStrip.innerHTML = '';
  if (allTags.length > 0) {
    homeTagsBox.classList.remove('hidden');
    for (const tag of allTags) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip-btn';
      btn.textContent = `#${tag}`;
      btn.addEventListener('click', () => openDeckWorkspace('all', 'study', tag));
      homeTagStrip.appendChild(btn);
    }
  } else {
    homeTagsBox.classList.add('hidden');
  }
}

function updateCarouselIndicator() {
  const carousel = document.getElementById('deck-carousel');
  const dots = document.querySelectorAll('#carousel-dots .dot');
  const cards = [...carousel.children];
  if (!cards.length) return;

  const center = carousel.scrollTop + carousel.clientHeight / 2;
  let closestIdx = 0;
  let minDist = Infinity;
  cards.forEach((card, i) => {
    const cardCenter = card.offsetTop + card.offsetHeight / 2;
    const dist = Math.abs(center - cardCenter);
    if (dist < minDist) {
      minDist = dist;
      closestIdx = i;
    }
  });

  cards.forEach((card, i) => card.classList.toggle('is-active', i === closestIdx));
  dots.forEach((d, i) => d.classList.toggle('active', i === closestIdx));
}

async function createNewDeck(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return;
  const deck = {
    id: crypto.randomUUID ? crypto.randomUUID() : `deck-${Date.now()}`,
    name: trimmed,
    createdAt: Date.now(),
  };
  await putToStore(DECK_STORE, deck);
  await refreshAll();
  const carousel = document.getElementById('deck-carousel');
  const createdSlide = carousel.children[carousel.children.length - 2];
  if (createdSlide) createdSlide.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// --- 単語帳ワークスペース ---
function renderTagChips(stripId, cards, selectedTag, onSelect) {
  const strip = document.getElementById(stripId);
  strip.innerHTML = '';
  const tags = getAllUniqueTags(cards);
  if (tags.length === 0) {
    strip.classList.add('hidden');
    return;
  }
  strip.classList.remove('hidden');

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = `chip-btn${selectedTag === 'all' ? ' active' : ''}`;
  allBtn.textContent = 'すべて';
  allBtn.addEventListener('click', () => onSelect('all'));
  strip.appendChild(allBtn);

  for (const tag of tags) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chip-btn${selectedTag === tag ? ' active' : ''}`;
    btn.textContent = `#${tag}`;
    btn.addEventListener('click', () => onSelect(tag));
    strip.appendChild(btn);
  }
}

function renderFormHelpers() {
  const targetField = document.getElementById('target-deck-field');
  const targetStrip = document.getElementById('target-deck-strip');
  targetStrip.innerHTML = '';

  if (activeDeckId === 'all') {
    targetField.classList.remove('hidden');
    const sortedDecks = [...allDecks].sort((a, b) => a.createdAt - b.createdAt);
    for (const deck of sortedDecks) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `chip-btn${formTargetDeckId === deck.id ? ' active' : ''}`;
      btn.textContent = deck.name;
      btn.addEventListener('click', () => {
        formTargetDeckId = deck.id;
        renderFormHelpers();
      });
      targetStrip.appendChild(btn);
    }
  } else {
    targetField.classList.add('hidden');
  }

  renderPendingFormTags();
}

function getDeckScopedCards() {
  return activeDeckId === 'all' ? allCards : allCards.filter((c) => c.deckId === activeDeckId);
}

function renderWorkspace() {
  const scoped = getDeckScopedCards();
  const validTags = getAllUniqueTags(scoped);
  if (activeTag !== 'all' && !validTags.includes(activeTag)) activeTag = 'all';

  renderTagChips('study-tag-strip', scoped, activeTag, (tag) => {
    activeTag = tag;
    renderWorkspace();
  });
  renderTagChips('manage-tag-strip', scoped, activeTag, (tag) => {
    activeTag = tag;
    renderWorkspace();
  });

  renderFormHelpers();
  renderCardList();
  rebuildQueue();
}

// --- 学習ロジック ---
function getStudyFilteredCards() {
  return getDeckScopedCards().filter(
    (c) => activeTag === 'all' || c.tags.includes(activeTag) || c.front === activeTag
  );
}

function rebuildQueue() {
  const practiceAll = document.getElementById('toggle-all').checked;
  const now = Date.now();
  const filtered = getStudyFilteredCards();
  studyQueue = practiceAll
    ? [...filtered].sort((a, b) => a.dueAt - b.dueAt)
    : filtered.filter((c) => c.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
  currentIndex = 0;
  showingBack = false;
  renderStudyCard();
}

function renderRelatedCards(card) {
  const box = document.getElementById('related-box');
  const list = document.getElementById('related-list');
  list.innerHTML = '';

  const related = allCards
    .filter(
      (c) =>
        c.id !== card.id &&
        (card.tags.includes(c.front) ||
          c.tags.includes(card.front) ||
          c.tags.some((t) => card.tags.includes(t)))
    )
    .sort((a, b) => Number(b.deckId !== card.deckId) - Number(a.deckId !== card.deckId))
    .slice(0, 5);

  if (related.length === 0) {
    box.classList.add('hidden');
    return;
  }

  for (const item of related) {
    const li = document.createElement('li');
    li.className = 'related-item';

    const left = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = item.front;
    const sep = document.createTextNode(` — ${item.back}`);
    left.append(strong, sep);

    const deckSpan = document.createElement('span');
    deckSpan.textContent = getDeckName(item.deckId);

    li.append(left, deckSpan);
    list.appendChild(li);
  }
  box.classList.remove('hidden');
}

function renderStudyCard() {
  const deckEl = document.getElementById('card-deck');
  const sideEl = document.getElementById('card-side');
  const faceEl = document.getElementById('card-face');
  const noteEl = document.getElementById('card-note');
  const tagsEl = document.getElementById('card-tags');
  const subEl = document.getElementById('card-sub');
  const relatedBox = document.getElementById('related-box');
  const progressEl = document.getElementById('study-progress');
  const revealWrap = document.getElementById('reveal-wrap');
  const ratingGrid = document.getElementById('rating-grid');

  tagsEl.innerHTML = '';

  if (studyQueue.length === 0) {
    deckEl.classList.add('hidden');
    sideEl.textContent = '';
    noteEl.textContent = '';
    relatedBox.classList.add('hidden');
    revealWrap.classList.add('hidden');
    ratingGrid.classList.add('hidden');
    progressEl.textContent = '0 枚';

    const scoped = getStudyFilteredCards();
    if (scoped.length === 0) {
      faceEl.textContent = '対象の単語がありません';
      subEl.textContent = '「登録」から追加してください';
    } else {
      const nextDue = Math.min(...scoped.map((c) => c.dueAt));
      const badge = formatDueBadge({ reps: 1, interval: 1, dueAt: nextDue });
      faceEl.textContent = '復習完了';
      subEl.textContent = `次の復習予定: ${badge.text}`;
    }
    return;
  }

  const card = studyQueue[currentIndex];
  const practiceAll = document.getElementById('toggle-all').checked;
  progressEl.textContent = practiceAll
    ? `${currentIndex + 1} / ${studyQueue.length}`
    : `残り ${studyQueue.length} 枚`;

  deckEl.textContent = getDeckName(card.deckId);
  deckEl.classList.remove('hidden');

  for (const tag of card.tags) {
    const span = document.createElement('span');
    span.className = 'tag-chip';
    span.textContent = `#${tag}`;
    tagsEl.appendChild(span);
  }

  if (showingBack) {
    sideEl.textContent = 'ANSWER';
    faceEl.textContent = card.back;
    noteEl.textContent = card.note || '';
    subEl.textContent = '';
    renderRelatedCards(card);
    revealWrap.classList.add('hidden');
    ratingGrid.classList.remove('hidden');

    for (const q of [1, 3, 4, 5]) {
      document.getElementById(`int-${q}`).textContent = computeSM2(card, q).label;
    }
  } else {
    sideEl.textContent = 'QUESTION';
    faceEl.textContent = card.front;
    noteEl.textContent = '';
    subEl.textContent = 'タップで裏返す';
    relatedBox.classList.add('hidden');
    revealWrap.classList.remove('hidden');
    ratingGrid.classList.add('hidden');
  }
}

// --- 登録・一覧ロジック ---
function getFilteredListCards() {
  const query = document.getElementById('search-input').value.trim().toLowerCase();
  return getDeckScopedCards()
    .filter((c) => {
      if (activeTag !== 'all' && !c.tags.includes(activeTag) && c.front !== activeTag) return false;
      if (query) {
        const hay = `${c.front} ${c.back} ${c.note} ${c.tags.join(' ')} ${getDeckName(c.deckId)}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function renderCardList() {
  const listEl = document.getElementById('card-list');
  const countEl = document.getElementById('list-count');
  listEl.innerHTML = '';

  const filtered = getFilteredListCards();
  countEl.textContent = `${filtered.length} 件`;

  for (const card of filtered) {
    const li = document.createElement('li');
    li.className = 'card-item';

    const row = document.createElement('div');
    row.className = 'card-item-row';

    const textWrap = document.createElement('div');
    textWrap.className = 'card-item-text';

    const top = document.createElement('div');
    top.className = 'card-item-top';

    const front = document.createElement('div');
    front.className = 'card-item-front';
    front.textContent = card.front;

    top.appendChild(front);

    if (activeDeckId === 'all') {
      const deckBadge = document.createElement('span');
      deckBadge.className = 'deck-pill';
      deckBadge.textContent = getDeckName(card.deckId);
      top.appendChild(deckBadge);
    }

    const dueInfo = formatDueBadge(card);
    const due = document.createElement('span');
    due.className = `card-item-due${dueInfo.isDue ? ' due' : ''}`;
    due.textContent = dueInfo.text;
    top.appendChild(due);

    const back = document.createElement('div');
    back.className = 'card-item-back';
    back.textContent = card.back;

    textWrap.append(top, back);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const linkerWrap = document.createElement('div');
    linkerWrap.className = 'inline-linker hidden';

    const linkerInput = document.createElement('input');
    linkerInput.type = 'search';
    linkerInput.placeholder = '関連づける単語を検索して選択';

    const linkerResults = document.createElement('div');
    linkerResults.className = 'picker-results hidden';

    linkerInput.addEventListener('input', () => {
      const matches = searchCardsForTag(linkerInput.value, card.id, card.deckId);
      renderPickerResults(linkerResults, matches, async (target) => {
        await linkCardWithTarget(card, target);
        await refreshAll();
      });
    });

    linkerWrap.append(linkerInput, linkerResults);

    const addTagBtn = document.createElement('button');
    addTagBtn.type = 'button';
    addTagBtn.className = 'btn-ghost';
    addTagBtn.textContent = '+タグ';
    addTagBtn.addEventListener('click', () => {
      const opening = linkerWrap.classList.toggle('hidden');
      if (!opening) {
        linkerInput.value = '';
        linkerResults.classList.add('hidden');
        linkerInput.focus();
      }
    });

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-ghost';
    editBtn.textContent = '編集';
    editBtn.addEventListener('click', async () => {
      formTargetDeckId = card.deckId;
      document.getElementById('input-front').value = card.front;
      document.getElementById('input-back').value = card.back;
      document.getElementById('input-note').value = card.note || '';
      pendingLinkTargets = card.tags.map((tag) => {
        const match = allCards.find((c) => c.id !== card.id && c.front === tag);
        return { cardId: match ? match.id : null, tag };
      });

      const now = Date.now();
      const counterparts = allCards.filter(
        (c) => c.id !== card.id && c.tags.includes(card.front)
      );
      for (const cp of counterparts) {
        cp.tags = cp.tags.filter((t) => t !== card.front);
        cp.updatedAt = now;
        await putToStore(CARD_STORE, cp);
      }
      await deleteFromStore(CARD_STORE, card.id);

      await refreshAll();
      setSearchOpen(false);
      setSubTab('add');
      renderFormHelpers();
      document.getElementById('add-msg').textContent = `「${card.front}」を編集用に読み込みました`;
      document.getElementById('input-front').focus();
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn-danger';
    delBtn.textContent = '削除';
    delBtn.addEventListener('click', async () => {
      await deleteFromStore(CARD_STORE, card.id);
      await refreshAll();
    });

    actions.append(editBtn, addTagBtn, delBtn);
    row.append(textWrap, actions);
    li.appendChild(row);

    if (card.tags.length > 0) {
      const tagsWrap = document.createElement('div');
      tagsWrap.className = 'card-item-tags';
      for (const tag of card.tags) {
        const chip = document.createElement('span');
        chip.className = 'tag-chip';
        chip.textContent = `#${tag}`;

        const rm = document.createElement('button');
        rm.type = 'button';
        rm.textContent = '×';
        rm.setAttribute('aria-label', `${tag}を削除`);
        rm.addEventListener('click', async () => {
          const now = Date.now();
          card.tags = card.tags.filter((t) => t !== tag);
          card.updatedAt = now;
          await putToStore(CARD_STORE, card);

          const counterparts = allCards.filter(
            (c) => c.id !== card.id && c.front === tag && c.tags.includes(card.front)
          );
          for (const cp of counterparts) {
            cp.tags = cp.tags.filter((t) => t !== card.front);
            cp.updatedAt = now;
            await putToStore(CARD_STORE, cp);
          }
          await refreshAll();
        });

        chip.appendChild(rm);
        tagsWrap.appendChild(chip);
      }
      li.appendChild(tagsWrap);
    }

    li.appendChild(linkerWrap);
    listEl.appendChild(li);
  }
}

async function refreshAll() {
  await ensureDefaultDeck();
  allDecks = await getAllFromStore(DECK_STORE);
  allCards = (await getAllFromStore(CARD_STORE)).map(normalizeCard);
  renderHomeCarousel();
  if (document.getElementById('page-deck').classList.contains('active')) {
    renderWorkspace();
  }
}

// --- イベント登録 ---
document.getElementById('deck-carousel').addEventListener('scroll', () => {
  requestAnimationFrame(updateCarouselIndicator);
});

document.getElementById('btn-home-search').addEventListener('click', () => {
  document.getElementById('search-input').value = '';
  openDeckWorkspace('all', 'search');
});
document.getElementById('btn-toggle-search').addEventListener('click', () => {
  setSearchOpen(!searchOpen);
});
document.getElementById('btn-open-backup').addEventListener('click', () => showPage('page-backup'));
document.getElementById('btn-back-home').addEventListener('click', () => {
  setSearchOpen(false);
  renderHomeCarousel();
  showPage('page-home');
});
document.getElementById('btn-backup-back').addEventListener('click', () => {
  renderHomeCarousel();
  showPage('page-home');
});

document.querySelectorAll('.sub-nav button').forEach((btn) => {
  btn.addEventListener('click', () => setSubTab(btn.dataset.subtab));
});

document.getElementById('flashcard').addEventListener('click', () => {
  if (studyQueue.length === 0) return;
  showingBack = !showingBack;
  renderStudyCard();
});

document.getElementById('btn-reveal').addEventListener('click', () => {
  if (studyQueue.length === 0) return;
  showingBack = true;
  renderStudyCard();
});

document.querySelectorAll('.rating-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (studyQueue.length === 0) return;
    const quality = Number(btn.dataset.q);
    const card = studyQueue[currentIndex];
    const next = computeSM2(card, quality);

    const updated = {
      ...card,
      reps: next.reps,
      interval: next.interval,
      ease: next.ease,
      dueAt: next.dueAt,
      updatedAt: Date.now(),
    };
    await putToStore(CARD_STORE, updated);

    const practiceAll = document.getElementById('toggle-all').checked;
    allCards = (await getAllFromStore(CARD_STORE)).map(normalizeCard);
    renderCardList();

    if (practiceAll) {
      studyQueue = studyQueue.map((c) => (c.id === updated.id ? updated : c));
      currentIndex = (currentIndex + 1) % studyQueue.length;
    } else if (quality === 1) {
      studyQueue.splice(currentIndex, 1);
      studyQueue.push(updated);
      if (currentIndex >= studyQueue.length) currentIndex = 0;
    } else {
      studyQueue.splice(currentIndex, 1);
      if (currentIndex >= studyQueue.length) currentIndex = 0;
    }

    showingBack = false;
    renderStudyCard();
  });
});

document.getElementById('toggle-all').addEventListener('change', rebuildQueue);

document.getElementById('btn-shuffle').addEventListener('click', () => {
  for (let i = studyQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [studyQueue[i], studyQueue[j]] = [studyQueue[j], studyQueue[i]];
  }
  currentIndex = 0;
  showingBack = false;
  renderStudyCard();
});

document.getElementById('input-front').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  const hint = document.getElementById('dup-hint');
  if (!q) {
    hint.classList.add('hidden');
    return;
  }
  const matches = allCards.filter((c) => c.front.toLowerCase().includes(q)).slice(0, 3);
  if (matches.length === 0) {
    hint.classList.add('hidden');
    return;
  }
  hint.textContent = `既存: ${matches
    .map((m) => `${m.front}（${getDeckName(m.deckId)}）`)
    .join(' / ')}`;
  hint.classList.remove('hidden');
});

// 登録フォームの「単語検索 → #見出し語」ピッカー（登録済み単語のみ選択可）
const tagWordSearchEl = document.getElementById('tag-word-search');
tagWordSearchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.preventDefault();
});
tagWordSearchEl.addEventListener('input', (e) => {
  const resultsEl = document.getElementById('tag-search-results');
  const deckId = activeDeckId === 'all' ? formTargetDeckId : activeDeckId;
  const matches = searchCardsForTag(e.target.value, null, deckId);
  renderPickerResults(resultsEl, matches, (target) => {
    const tag = target.front.trim();
    if (tag && !pendingLinkTargets.some((x) => x.tag === tag)) {
      pendingLinkTargets.push({ cardId: target.id, tag });
      renderPendingFormTags();
    }
    e.target.value = '';
    resultsEl.classList.add('hidden');
  });
});

document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const frontInput = document.getElementById('input-front');
  const backInput = document.getElementById('input-back');
  const noteInput = document.getElementById('input-note');
  const deckId = activeDeckId === 'all' ? formTargetDeckId : activeDeckId;

  const front = frontInput.value.trim();
  const back = backInput.value.trim();
  if (!front || !back) return;

  const newCard = normalizeCard({
    deckId,
    front,
    back,
    note: noteInput.value.trim(),
    tags: pendingLinkTargets.map((x) => x.tag),
  });
  await putToStore(CARD_STORE, newCard);

  // 選んだ既存単語側にも、今回追加したカードの見出し語を相互タグとして付与
  for (const link of pendingLinkTargets) {
    const target = allCards.find((c) => c.id === link.cardId);
    if (target && !target.tags.includes(newCard.front)) {
      target.tags = parseTags([...target.tags, newCard.front]);
      target.updatedAt = Date.now();
      await putToStore(CARD_STORE, target);
    }
  }

  pendingLinkTargets = [];
  frontInput.value = '';
  backInput.value = '';
  noteInput.value = '';
  document.getElementById('tag-word-search').value = '';
  document.getElementById('tag-search-results').classList.add('hidden');
  document.getElementById('dup-hint').classList.add('hidden');
  renderPendingFormTags();
  document.getElementById('add-msg').textContent = `「${newCard.front}」を追加しました`;
  frontInput.focus();
  await refreshAll();
});

document.getElementById('search-input').addEventListener('input', renderCardList);

// --- JSON エクスポート / インポート ---
document.getElementById('btn-export').addEventListener('click', async () => {
  const decks = await getAllFromStore(DECK_STORE);
  const cards = (await getAllFromStore(CARD_STORE)).map(normalizeCard);
  const payload = {
    version: 3,
    exportedAt: new Date().toISOString(),
    decks,
    cards,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `flashcards-${date}.json`;
  a.click();
  URL.revokeObjectURL(url);
  document.getElementById('backup-msg').textContent = `単語帳${decks.length}件・単語${cards.length}件を書き出しました。`;
});

document.getElementById('input-import').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const msgEl = document.getElementById('backup-msg');

  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const decks = Array.isArray(parsed.decks) ? parsed.decks : [];
    const items = Array.isArray(parsed) ? parsed : parsed.cards;
    if (!Array.isArray(items)) throw new Error('形式が正しくありません');

    for (const deck of decks) {
      if (deck.id && deck.name) {
        await putToStore(DECK_STORE, {
          id: String(deck.id),
          name: String(deck.name),
          createdAt: deck.createdAt || Date.now(),
        });
      }
    }

    let count = 0;
    for (const item of items) {
      if (!item.front || !item.back) continue;
      await putToStore(CARD_STORE, normalizeCard(item));
      count++;
    }
    await refreshAll();
    msgEl.textContent = `${count}件の単語を読み込みました。`;
  } catch (err) {
    msgEl.textContent = `読み込みに失敗しました: ${err.message}`;
  } finally {
    e.target.value = '';
  }
});

// --- オンライン状態 & Service Worker ---
function updateNetStatus() {
  document.getElementById('net-status').textContent = navigator.onLine ? 'オンライン' : 'オフライン';
}
window.addEventListener('online', updateNetStatus);
window.addEventListener('offline', updateNetStatus);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(console.error);
  });
}

updateNetStatus();
refreshAll();
