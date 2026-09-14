'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const fold = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('ru').replace(/ß/g, 'ss');
const number = value => value === null || value === undefined || value === '' ? '—' : new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 0}).format(value);
const money = value => value == null ? 'Цена не указана' : `${number(value)} €`;
const countries = {DE: 'Германия', IT: 'Италия', BE: 'Бельгия', FR: 'Франция', NL: 'Нидерланды', LU: 'Люксембург', SK: 'Словакия', RO: 'Румыния', ES: 'Испания', LT: 'Литва', LV: 'Латвия', AT: 'Австрия'};
const kinds = {equipment: 'Список оборудования', attribute: 'Характеристики', description: 'Описание продавца', title: 'Заголовок объявления'};
const fields = ['search', 'price-min', 'price-max', 'mileage-min', 'mileage-max', 'year', 'country', 'source', 'hide-accident', 'verified-v8', 'duplicates', 'updates', 'hide-unavailable', 'luxury-min', 'evidence', 'sort'];
const defaults = {'search': '', 'price-min': '', 'price-max': '', 'mileage-min': '', 'mileage-max': '', year: '', country: '', source: '', 'hide-accident': false, 'verified-v8': false, duplicates: false, updates: '', 'hide-unavailable': false, 'luxury-min': '', evidence: 'all', sort: 'price-asc', mode: 'all', options: []};
let dataset;
let cars = [];
let catalogue = [];
let optionMap = new Map();
let carMap = new Map();
let selected = new Set();
let filtered = [];
let visibleLimit = 24;
let toastTimer;
let searchTimer;
let optionCounts = new Map();
let activeCar;
let galleryIndex = 0;
let lastFocused;
let lastOptionFocus;
let baselineIds = new Set();

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3600);
}

function controls() {
  const state = {mode: $('input[name="mode"]:checked').value, options: Array.from(selected)};
  fields.forEach(id => { state[id] = $(`#${id}`).type === 'checkbox' ? $(`#${id}`).checked : $(`#${id}`).value; });
  return state;
}

function setControls(state = defaults) {
  fields.forEach(id => {
    const input = $(`#${id}`);
    if (input.type === 'checkbox') input.checked = state[id] === true;
    else input.value = state[id] ?? defaults[id];
    if (input.tagName === 'SELECT' && input.selectedIndex < 0) input.value = defaults[id];
  });
  const mode = state.mode === 'any' ? 'any' : 'all';
  $(`input[name="mode"][value="${mode}"]`).checked = true;
  selected = new Set((Array.isArray(state.options) ? state.options : []).filter(id => optionMap.has(id)).slice(0, 200));
}

function readHash() {
  if (!location.hash.startsWith('#f=')) return defaults;
  try {
    const raw = JSON.parse(decodeURIComponent(location.hash.slice(3)));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
    const clean = {...defaults};
    Object.keys(defaults).forEach(key => {
      if (key === 'options' && Array.isArray(raw.options)) clean.options = raw.options.filter(value => typeof value === 'string').slice(0, 200);
      else if (typeof raw[key] === typeof defaults[key]) clean[key] = typeof raw[key] === 'string' ? raw[key].slice(0, 500) : raw[key];
    });
    return clean;
  } catch {
    toast('Не удалось прочитать фильтры из ссылки. Показана вся подборка.');
    return defaults;
  }
}

function saveHash(state) {
  const compact = Object.fromEntries(Object.entries(state).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(defaults[key])));
  const hash = Object.keys(compact).length ? `#f=${encodeURIComponent(JSON.stringify(compact))}` : '';
  try { history.replaceState(null, '', location.pathname + location.search + hash); } catch { }
}

function featureIds(car, evidenceMode) {
  return evidenceMode === 'structured' ? car.structuredIds : car.optionIds;
}

let radar = null;

function recent(timestamp, reference = Date.now()) {
  const at = Date.parse(timestamp ?? '');
  return Number.isFinite(at) && at <= reference && reference - at <= 7 * 86400000;
}

function tracking(car) {
  return radar?.listings?.[car.id];
}

function monitorMatch(car, state) {
  const track = tracking(car);
  if (state['hide-unavailable'] && track?.status === 'not_found') return false;
  if (state.updates === 'new') return !!track && !track.baseline && recent(track.first_seen);
  if (state.updates === 'price_drop') return recent(track?.last_price_drop_at);
  if (state.updates === 'not_found') return track?.status === 'not_found';
  return true;
}

function dateTime(value) {
  return value ? new Date(value).toLocaleString('ru-RU', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}) : 'ещё не было';
}

function monitorBadges(car) {
  const track = tracking(car);
  if (!track) return '';
  return `${track.status === 'not_found' ? '<span class="badge danger">Не найдено в поиске</span>' : ''}${!track.baseline && recent(track.first_seen) ? '<span class="badge new">Новое · 7 дней</span>' : ''}${recent(track.last_price_drop_at) ? '<span class="badge drop">Цена снижалась</span>' : ''}${track.status === 'snapshot' ? '<span class="badge">Снимок · без автообновления</span>' : ''}`;
}

function renderRadar() {
  const panel = $('#radar-panel');
  if (!radar) {
    panel.innerHTML = '<h2>Радар объявлений</h2><p>История мониторинга сейчас недоступна. Показаны сохранённые объявления.</p>';
    return;
  }
  const newCount = cars.filter(car => monitorMatch(car, {updates: 'new'})).length;
  const dropCount = cars.filter(car => monitorMatch(car, {updates: 'price_drop'})).length;
  const labels = {new: 'Новое объявление', price_drop: 'Снижение цены', price_increase: 'Повышение цены', not_found: 'Не найдено в поиске', returned: 'Снова найдено'};
  const events = radar.events.slice(0, 15);
  panel.innerHTML = `<div class="radar-heading"><div><p class="eyebrow">СОХРАНЁННЫЙ ПОИСК</p><h2>Радар Cayenne V8</h2><p>AutoScout24 · каждые 6 часов · уведомления только здесь</p></div><span class="radar-state ${radar.status === 'error' ? 'error' : ''}">${radar.status === 'ok' ? 'Последняя проверка успешна' : radar.status === 'error' ? 'Источник не удалось проверить' : 'Ожидает первой проверки'}</span></div><div class="radar-actions"><button type="button" data-radar-filter="new"><strong>${newCount}</strong><span>Новых за 7 дней</span></button><button type="button" data-radar-filter="price_drop"><strong>${dropCount}</strong><span>Снижений цены · 7 дней</span></button><div><span>Последняя успешная проверка</span><strong>${escapeHTML(dateTime(radar.last_success))}</strong><small>Последняя попытка: ${escapeHTML(dateTime(radar.last_attempt))}</small></div></div>${radar.status === 'error' ? `<p class="radar-warning">${escapeHTML(radar.message)} Сетевая ошибка не считается исчезновением автомобилей.</p>` : ''}<details class="radar-log"><summary>Лента изменений <span>${radar.events.length}</span></summary>${events.length ? events.map(event => `<div class="radar-event"><div><span>${escapeHTML(labels[event.type] ?? event.type)} · ${escapeHTML(dateTime(event.at))}</span><button type="button" data-open="${escapeHTML(event.listing_id)}">${escapeHTML(event.title)}</button>${event.old_price != null ? `<small>${money(event.old_price)} → ${money(event.price)}</small>` : event.price != null ? `<small>${money(event.price)}</small>` : ''}${event.type === 'new' && event.possible_duplicate ? '<small>Есть возможный дубль — это может быть повторное объявление.</small>' : ''}</div></div>`).join('') : '<p>Новых событий пока нет. Исходная подборка сохранена как база и не объявляется новой.</p>'}<p class="hint">Показаны последние 15 событий, в журнале хранятся последние 300. «Не найдено» — после двух успешных проверок подряд, а не подтверждение продажи.</p></details><details class="radar-search"><summary>Условия поиска и ограничения</summary><p>${escapeHTML(radar.saved_search.description)}</p><p>Время первого обнаружения не равно дате публикации продавцом. Расписание GitHub может задерживаться и не гарантирует точный час. Объявления mobile.de остаются исходным снимком и автоматически не проверяются.</p><a href="${escapeHTML(radar.search_url)}" target="_blank" rel="noopener noreferrer">Поиск AutoScout24 ↗</a></details>`;
}

function priceHistoryHTML(car) {
  const track = tracking(car);
  if (!track) return '';
  const history = [...track.price_history].reverse().slice(0, 30);
  return `<section class="detail-section price-history"><h3>Наблюдение и история цены</h3><p>${track.status === 'snapshot' ? 'mobile.de: сохранённый снимок, автоматическое обновление не подключено.' : track.status === 'not_found' ? 'Не найдено в двух полных проверках поиска подряд. Это не означает, что автомобиль продан.' : 'AutoScout24: объявление отслеживается.'}</p><p>Впервые замечено: ${escapeHTML(dateTime(track.first_seen))} · Последний раз найдено: ${escapeHTML(dateTime(track.last_seen))}</p><table><thead><tr><th>Зафиксировано</th><th>Цена</th></tr></thead><tbody>${history.map(item => `<tr><td>${escapeHTML(dateTime(item.at))}</td><td>${money(item.price)}</td></tr>`).join('')}</tbody></table><p class="hint">Показаны последние 30 изменений. Это цены объявлений, не суммы сделок.</p></section>`;
}

const LUXURY_GROUPS = [
  {burmester: 25, bose: 8},
  {pccb: 28, pscb: 14},
  {pdcc: 18},
  {air_suspension: 14, pasm: 4, adaptive_suspension: 2},
  {rear_steering: 12},
  {ptv_plus: 8, ptv: 5},
  {lightweight: 24, carbon_roof: 14, panorama: 6, sunroof: 3},
  {sport_design: 14},
  {sports_exhaust: 9},
  {sport_chrono: 7},
  {hd_matrix: 10, matrix_led: 5},
  {innodrive: 9, acc: 4, cruise: 0},
  {night_vision: 8},
  {seats_18: 8, seats_14: 5},
  {seat_massage: 10, seat_vent: 5},
  {club_leather: 10, full_leather: 5},
  {camera_360: 6, self_parking: 4, rear_camera: 2},
  {hud: 6},
  {passenger_display: 6},
  {soft_close: 5},
  {aux_heating: 7},
  {acoustic_glass: 5},
  {climate_4: 4, climate_3: 2},
  {wheels_22: 7, wheels_21: 3},
  {rear_entertainment: 7},
  {rear_vent: 4},
  {rear_blinds: 3},
  {trailer_pivot: 4, trailer_fixed: 3, trailer_hitch: 3},
  {heated_windshield: 2},
  {heated_steering: 2},
  {rear_seat_heat: 2},
  {keyless: 2},
  {homelink: 1},
  {ionizer: 1}
];

function luxuryScore(car, evidenceMode = 'all') {
  const items = [];
  for (const group of LUXURY_GROUPS) {
    let best = null;
    for (const [id, weight] of Object.entries(group)) {
      if (!weight || car.conflicts?.includes(id)) continue;
      const rows = (car.features?.[id] ?? []).filter(row => evidenceMode !== 'structured' || ['equipment', 'attribute'].includes(row.kind));
      if (!rows.length) continue;
      const titleOnly = rows.every(row => row.kind === 'title');
      const points = weight * (titleOnly ? 0.5 : 1);
      if (!best || points > best.points) best = {id, weight, points, titleOnly};
    }
    if (best) items.push(best);
  }
  items.sort((a, b) => b.points - a.points || a.id.localeCompare(b.id));
  return {total: items.reduce((sum, item) => sum + item.points, 0), items};
}

function carLuxury(car, mode = controls().evidence) {
  return (mode === 'structured' ? car.luxuryStructured : car.luxury) ?? luxuryScore(car, mode);
}

function originalPrice(description) {
  const match = String(description ?? '').match(/(?:ehemaliger\s+)?\bNeupreis\s*:?\s*([\d][\d.,\s]*?)\s*(?:€|euro)(?!\w)/i);
  if (!match) return null;
  const value = Number(match[1].replace(/\s/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? {value, quote: match[0]} : null;
}

function scoreNumber(value) {
  return new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 1}).format(value);
}

function richnessHTML(car) {
  const score = carLuxury(car);
  const original = car.newPrice;
  return `<section class="richness-panel detail-section"><div class="richness-heading"><div><p class="eyebrow">ДОРОГОЕ ОСНАЩЕНИЕ</p><h3>Жирность комплектации</h3></div><strong>${scoreNumber(score.total)}<small>баллов</small></strong></div><p>Мой сравнительный индекс по указанным опциям, не цена нового автомобиля и не процент от максимума. Неполное объявление может получить меньше баллов. Пробег, нынешняя цена, гарантия и обычные функции вроде ABS на баллы не влияют.</p>${original ? `<p class="original-price-note">Продавец указал цену новой машины: <strong>${money(original.value)}</strong><br><span>${escapeHTML(original.quote)}. Это заявление продавца, не проверенная сумма сделки.</span></p>` : '<p class="hint">Первоначальная цена в объявлении не найдена.</p>'}<details class="score-breakdown"><summary>За что начислены баллы · ${score.items.length} групп</summary><p>Больше веса у дорогостоящих систем. В связанных группах берётся только лучший пункт: например, Burmester вместо суммы Burmester + BOSE; HD-Matrix вместо HD-Matrix + Matrix + LED. Одно упоминание в заголовке даёт половину баллов. Противоречивые пункты не учитываются. Режим «Только в списках и характеристиках» ограничивает и этот расчёт.</p><div>${score.items.map(item => `<div class="score-row"><button type="button" data-help="${escapeHTML(item.id)}">${escapeHTML(optionMap.get(item.id)?.label ?? item.id)}${item.titleOnly ? '<small>Только заголовок: × 0,5</small>' : ''}</button><strong>+${scoreNumber(item.points)}</strong></div>`).join('') || '<p>Нет подходящих подтверждений для взвешенной оценки.</p>'}</div></details></section>`;
}

function numeric(value) {
  if (value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function invalidRange(state) {
  for (const id of ['price-min', 'price-max', 'mileage-min', 'mileage-max', 'luxury-min']) {
    if (state[id] !== '' && numeric(state[id]) === null) return 'Цена, пробег и баллы должны быть неотрицательными числами.';
  }
  for (const prefix of ['price', 'mileage']) {
    const min = numeric(state[`${prefix}-min`]);
    const max = numeric(state[`${prefix}-max`]);
    if (min !== null && max !== null && min > max) return prefix === 'price' ? 'Цена «от» больше цены «до». Исправь диапазон.' : 'Пробег «от» больше пробега «до». Исправь диапазон.';
  }
  return '';
}

function baseMatch(car, state) {
  if (!monitorMatch(car, state)) return false;
  if (state.source && car.source !== state.source) return false;
  if (state.country && car.country !== state.country) return false;
  if (state.year && !String(car.registration ?? '').endsWith(state.year)) return false;
  if (state['hide-accident'] && car.repaired) return false;
  if (state['verified-v8'] && car.cylinders !== 8) return false;
  if (state.duplicates && !car.duplicate_group) return false;
  if (numeric(state['luxury-min'] ?? '') !== null && carLuxury(car, state.evidence).total < numeric(state['luxury-min'])) return false;
  if (state.search && !car.searchText.includes(fold(state.search.trim()))) return false;
  for (const [prefix, value] of [['price', car.price], ['mileage', car.mileage]]) {
    const min = numeric(state[`${prefix}-min`]);
    const max = numeric(state[`${prefix}-max`]);
    if ((min !== null || max !== null) && value == null) return false;
    if (min !== null && value < min || max !== null && value > max) return false;
  }
  return true;
}

function optionsMatch(car, state) {
  if (!selected.size) return true;
  const ids = featureIds(car, state.evidence);
  return state.mode === 'any' ? Array.from(selected).some(id => ids.has(id)) : Array.from(selected).every(id => ids.has(id));
}

function apply({resetLimit = true, updateHash = true} = {}) {
  if (!dataset) return;
  const state = controls();
  const error = invalidRange(state);
  $('#filter-error').hidden = !error;
  $('#filter-error').textContent = error;
  const base = error ? [] : cars.filter(car => baseMatch(car, state));
  filtered = base.filter(car => optionsMatch(car, state));
  optionCounts = new Map();
  filtered.forEach(car => featureIds(car, state.evidence).forEach(id => optionCounts.set(id, (optionCounts.get(id) ?? 0) + 1)));
  $('#total').textContent = filtered.length;
  const compare = {'luxury-desc': (a, b) => carLuxury(b, state.evidence).total - carLuxury(a, state.evidence).total, 'luxury-asc': (a, b) => carLuxury(a, state.evidence).total - carLuxury(b, state.evidence).total, 'price-asc': (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity), 'price-desc': (a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity), 'mileage-asc': (a, b) => (a.mileage ?? Infinity) - (b.mileage ?? Infinity), 'options-desc': (a, b) => featureIds(b, state.evidence).size - featureIds(a, state.evidence).size, newest: (a, b) => b.registrationSort.localeCompare(a.registrationSort)}[state.sort];
  filtered.sort((a, b) => (compare ?? (() => 0))(a, b) || (a.price ?? Infinity) - (b.price ?? Infinity) || a.id.localeCompare(b.id));
  if (resetLimit) visibleLimit = 24;
  $('#result-count').textContent = `${filtered.length} ${declension(filtered.length, ['объявление', 'объявления', 'объявлений'])}`;
  $('#result-note').textContent = `из ${cars.length} · ${state.evidence === 'structured' ? 'только структурированные данные' : 'включая упоминания в тексте'}`;
  $('#selected-number').textContent = `${selected.size} выбрано`;
  const extra = fields.filter(id => id !== 'sort' && state[id] !== defaults[id]).length;
  $('#filter-badge').textContent = selected.size + extra || '';
  $('#status').textContent = `Найдено объявлений: ${filtered.length}`;
  $('#export').disabled = !filtered.length;
  $('#selected-chips').innerHTML = Array.from(selected).map(id => `<button type="button" class="selected-chip" data-toggle="${escapeHTML(id)}" aria-label="Убрать опцию ${escapeHTML(optionMap.get(id).label)}">${escapeHTML(optionMap.get(id).label)}<span aria-hidden="true">×</span></button>`).join('');
  $$('.quick-options [data-toggle]').forEach(button => button.setAttribute('aria-pressed', String(selected.has(button.dataset.toggle))));
  $$('.option-row input').forEach(input => { input.checked = selected.has(input.value); });
  $$('[data-option-count]').forEach(element => { element.textContent = optionCounts.get(element.dataset.optionCount) ?? 0; });
  renderCards();
  if (updateHash) saveHash(state);
}

function declension(value, forms) {
  const n = value % 100;
  return n > 10 && n < 20 ? forms[2] : value % 10 === 1 ? forms[0] : value % 10 >= 2 && value % 10 <= 4 ? forms[1] : forms[2];
}

function infoButton(id) {
  return `<button type="button" class="option-info" data-help="${escapeHTML(id)}" aria-label="Что такое ${escapeHTML(optionMap.get(id).label)}">i</button>`;
}

function renderBaseline() {
  const items = catalogue.filter(item => baselineIds.has(item.id));
  $('#baseline-count').textContent = items.length;
  $('#baseline-list').innerHTML = items.length ? items.map(item => `<div class="baseline-item"><span>${escapeHTML(item.label)}<small>${cars.length} / ${cars.length} объявлений</small></span>${infoButton(item.id)}</div>`).join('') : `<p class="baseline-empty">Пока нет опций, указанных в ${cars.length} из ${cars.length} объявлений. Неполные списки продавцов не считаем подтверждением наличия.</p>`;
}

function renderOptions() {
  const query = fold($('#option-search').value.trim());
  const previous = new Set($$('.option-group[open]').map(element => element.dataset.group));
  const groups = Object.keys(dataset.categories).map(category => {
    const items = catalogue.filter(item => !baselineIds.has(item.id) && item.category === category && (!query || item.searchText.includes(query)));
    if (!items.length) return '';
    const open = query || previous.has(category) || !$('#option-list').children.length && category === 'chassis';
    return `<details class="option-group" data-group="${escapeHTML(category)}" ${open ? 'open' : ''}><summary><span>${escapeHTML(dataset.categories[category])}</span><small>${items.length}</small></summary><div class="option-rows">${items.map(item => `<div class="option-line"><label class="option-row"><input type="checkbox" value="${escapeHTML(item.id)}" ${selected.has(item.id) ? 'checked' : ''}><span>${escapeHTML(item.label)}</span><small data-option-count="${escapeHTML(item.id)}" title="Объявлений с этой опцией в текущей выборке">${optionCounts.get(item.id) ?? 0}</small></label>${infoButton(item.id)}</div>`).join('')}</div></details>`;
  }).join('');
  $('#option-list').innerHTML = groups || '<p class="hint">Нет подходящих опций для фильтра. Общие для всех пункты находятся в базовом списке.</p>';
}

function optionBadges(car) {
  const ids = new Set(Array.from(featureIds(car, controls().evidence)).filter(id => !baselineIds.has(id)));
  const ordered = Array.from(new Set([...selected, ...dataset.priority, ...ids])).filter(id => ids.has(id));
  const shown = ordered.slice(0, 4);
  return shown.map(id => `<span class="option-pill ${selected.has(id) ? 'selected' : ''}">${escapeHTML(optionMap.get(id)?.label ?? id)}</span>`).join('') + (ids.size > shown.length ? `<span class="option-pill">+${ids.size - shown.length} опций</span>` : '');
}

function imageURL(value, size = 'mo-640') {
  if (!value) return '';
  const url = new URL(value);
  if (url.hostname === 'img.classistatic.de') url.searchParams.set('rule', size);
  return url.href;
}

function cardHTML(car) {
  const image = imageURL(car.images[0]);
  const name = (car.title ?? 'Porsche Cayenne').replace(/^Porsche Cayenne\s*/i, '') || 'Cayenne';
  return `<article class="car-card" data-car-id="${escapeHTML(car.id)}" data-luxury="${carLuxury(car).total}"><button class="car-photo" type="button" data-open="${escapeHTML(car.id)}" aria-label="Подробнее: ${escapeHTML(car.title)}"><span class="photo-placeholder">Cayenne</span>${image ? `<img src="${escapeHTML(image)}" alt="${escapeHTML(car.title)}" loading="lazy" decoding="async">` : ''}<span class="source-tag">${escapeHTML(car.source)}</span>${car.images.length ? `<span class="photo-count">${car.images.length} фото</span>` : ''}</button><div class="car-info"><div class="car-topline"><span class="mini-label">PORSCHE CAYENNE</span>${monitorBadges(car)}${car.repaired ? '<span class="badge danger">После ДТП</span>' : ''}${car.status === 'needs_check' ? '<span class="badge warn">Проверить V8</span>' : ''}${car.duplicate_group ? `<span class="badge">Дубль? ${escapeHTML(car.duplicate_group)}</span>` : ''}</div><button class="car-title" type="button" data-open="${escapeHTML(car.id)}">${escapeHTML(name)}</button><button type="button" class="luxury-badge" data-open="${escapeHTML(car.id)}" title="Индекс дорогого оснащения, не первоначальная цена">Жирность · ${scoreNumber(carLuxury(car).total)} баллов</button><div class="car-price">${money(car.price)}</div><div class="car-net">${car.net_price != null ? `${money(car.net_price)} нетто${car.vat ? ` · НДС ${escapeHTML(car.vat)}%` : ''}` : 'Нетто-цена не указана'}</div><div class="car-facts"><span>${escapeHTML(car.registration ?? '—')}</span><span>${number(car.mileage)} км</span><span>${number(car.hp)} л.с.</span></div><div class="car-options">${optionBadges(car)}</div><div class="car-location" title="${escapeHTML(car.seller)}">${escapeHTML(countries[car.country] ?? car.country)} · ${escapeHTML(car.city)}</div><div class="car-bottom"><a href="${escapeHTML(car.url)}" target="_blank" rel="noopener noreferrer">На ${escapeHTML(car.source)} ↗</a><button type="button" data-open="${escapeHTML(car.id)}">Подробнее →</button></div></div></article>`;
}

function imageFallbacks(container) {
  container.querySelectorAll('img').forEach(image => image.addEventListener('error', () => { image.hidden = true; }, {once: true}));
}

function renderCards() {
  $('#cards').innerHTML = filtered.slice(0, visibleLimit).map(cardHTML).join('');
  imageFallbacks($('#cards'));
  $('#empty').hidden = filtered.length > 0;
  $('#load-more').hidden = filtered.length <= visibleLimit;
  $('#shown-count').textContent = filtered.length ? `Показано ${Math.min(visibleLimit, filtered.length)} из ${filtered.length}` : '';
}

function toggleOption(id) {
  if (!optionMap.has(id) || baselineIds.has(id) && !selected.has(id)) return;
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  apply();
}

function reset() {
  clearTimeout(searchTimer);
  setControls();
  $('#option-search').value = '';
  renderOptions();
  apply();
}

function evidenceRows(rows) {
  return rows.map(row => `<li>${escapeHTML(row.text)}<em>${escapeHTML(kinds[row.kind] ?? row.kind)}${row.via ? ` · через «${escapeHTML(row.via)}»` : ''}</em></li>`).join('');
}

function evidenceHTML(car, onlyBase = false) {
  const items = Object.keys(car.features).filter(id => baselineIds.has(id) === onlyBase).sort((a, b) => Number(selected.has(b)) - Number(selected.has(a)) || optionMap.get(a).label.localeCompare(optionMap.get(b).label, 'ru'));
  return Object.entries(dataset.categories).map(([category, label]) => {
    const ids = items.filter(id => optionMap.get(id).category === category);
    if (!ids.length) return '';
    return `<section class="equipment-category"><h4>${escapeHTML(label)}<span>${ids.length}</span></h4><div>${ids.map(id => {
      const rows = car.features[id];
      const structured = rows.some(row => ['equipment', 'attribute'].includes(row.kind));
      return `<div class="equipment-row"><details class="evidence-item ${selected.has(id) ? 'selected' : ''}"><summary>${escapeHTML(optionMap.get(id).label)}<span>${structured ? 'список / поле' : 'упоминание'}</span></summary><ul>${evidenceRows(rows)}</ul></details>${infoButton(id)}</div>`;
    }).join('')}</div></section>`;
  }).join('');
}

function showOption(id) {
  const option = optionMap.get(id);
  if (!option) return;
  lastOptionFocus = document.activeElement;
  const car = $('#detail-dialog').open ? activeCar : null;
  const rows = car?.features[id] ?? [];
  $('#option-content').innerHTML = `<div class="option-explainer"><p class="eyebrow">${escapeHTML(dataset.categories[option.category])}</p><h2 id="option-title">${escapeHTML(option.label)}</h2>${option.finder_name ? `<p class="finder-name">${escapeHTML(option.finder_name)}</p>` : ''}<p class="option-description">${escapeHTML(option.description)}</p><div class="option-coverage"><div><strong>${option.count} / ${cars.length}</strong><span>есть упоминание</span></div><div><strong>${option.structured_count} / ${cars.length}</strong><span>есть в списке или характеристиках</span></div></div>${baselineIds.has(id) ? '<p class="option-notice">Базовый пункт: указан во всех объявлениях полной подборки и поэтому убран из фильтров. Это не заявление о заводской серийной комплектации.</p>' : ''}${rows.length ? `<section class="option-proof"><h3>В этом объявлении</h3><ul>${evidenceRows(rows)}</ul></section>` : ''}<details class="option-aliases"><summary>Как ещё это называют в объявлениях</summary><div>${option.aliases.map(alias => `<span class="option-pill">${escapeHTML(alias)}</span>`).join('')}</div></details><p class="option-disclaimer">Это пояснение функции, а не проверка оснащения конкретной машины. Состав и доступность зависят от модели и года. Подтверждение комплектации — у продавца и по документам автомобиля.</p>${option.reference_url ? `<a class="option-reference" href="${escapeHTML(option.reference_url)}" target="_blank" rel="noopener noreferrer">Терминология Porsche Finder ↗</a>` : ''}${!baselineIds.has(id) ? `<button type="button" class="button primary option-apply" data-use-option="${escapeHTML(id)}">${selected.has(id) ? 'Убрать из фильтра' : 'Добавить в фильтр'}</button>` : ''}</div>`;
  const dialog = $('#option-dialog');
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  $('#close-option-dialog').focus();
}

function equipmentSections(car) {
  const highlights = Array.from(new Set([...selected, ...dataset.priority])).filter(id => car.optionIds.has(id) && !baselineIds.has(id)).slice(0, 12);
  const groups = evidenceHTML(car);
  const common = evidenceHTML(car, true);
  return `<section class="finder-equipment detail-section"><div class="finder-section-heading"><p class="eyebrow">ОСНАЩЕНИЕ АВТОМОБИЛЯ</p><h3>Комплектация</h3></div>${highlights.length ? `<h4 class="highlight-heading">Ключевые опции</h4><div class="equipment-highlights">${highlights.map(id => `<button type="button" class="equipment-highlight ${selected.has(id) ? 'selected' : ''}" data-help="${escapeHTML(id)}"><span class="highlight-category">${escapeHTML(dataset.categories[optionMap.get(id).category])}</span><strong>${escapeHTML(optionMap.get(id).label)}</strong><span class="highlight-more">Что это даёт <span aria-hidden="true">↗</span></span></button>`).join('')}</div>` : ''}<div class="equipment-heading"><h4>Оборудование, указанное в объявлении</h4><p>Сгруппировано по назначению. Раскрой пункт для оригинальной формулировки; кнопка «i» объясняет саму опцию.</p></div><p class="equipment-origin-note">Разделение на платные опции и серийное оснащение не подтверждено для этой машины. Не переносим заводскую комплектацию из другой карточки Porsche.</p><div class="equipment-categories">${groups}</div><details class="detail-baseline"><summary>Базовый список подборки <span>${baselineIds.size}</span></summary><p>Только пункты, указанные во всех ${cars.length} объявлениях, независимо от текущих фильтров. Не список заводского серийного оснащения.</p>${common || '<p>Пока список пуст: нет опций, подтверждённых во всех объявлениях без исключения.</p>'}</details></section>`;
}

function showCar(id) {
  const car = carMap.get(id);
  if (!car) return;
  activeCar = car;
  galleryIndex = 0;
  lastFocused = document.activeElement;
  const specs = [['Регистрация', car.registration], ['Пробег', `${number(car.mileage)} км`], ['Мощность', `${number(car.kw)} кВт / ${number(car.hp)} л.с.`], ['Двигатель', `${number(car.displacement)} см³ · ${number(car.cylinders)} цилиндров`], ['Владельцев', car.owners], ['Цвет', car.color], ['Салон', car.interior], ['Страна', countries[car.country] ?? car.country], ['Город', car.city], ['ДТП (по полям)', car.accident]];
  const duplicates = car.duplicate_group ? cars.filter(other => other.duplicate_group === car.duplicate_group && other.id !== car.id) : [];
  $('#detail-content').innerHTML = `<div class="detail-body"><div class="detail-head"><div><span class="detail-source">${escapeHTML(car.source)} · ${escapeHTML(car.id)}</span><h2 id="detail-title">${escapeHTML(car.title)}</h2><p class="detail-intro">${escapeHTML(car.seller ?? 'Продавец не указан')}<br>${escapeHTML(countries[car.country] ?? car.country)} · ${escapeHTML(car.city)}</p></div><div><div class="car-price">${money(car.price)}</div><p class="car-net">${car.net_price != null ? `${money(car.net_price)} нетто` : 'Нетто-цена не указана'}</p><a class="button primary" href="${escapeHTML(car.url)}" target="_blank" rel="noopener noreferrer">Открыть объявление ↗</a></div></div>${car.repaired ? '<p class="warn-note">Продавец указал отремонтированные последствия ДТП. Фильтр сайта «без повреждений» не исключает такие автомобили.</p>' : ''}${car.status === 'needs_check' ? `<p class="warn-note">${escapeHTML(car.engine_check)}. Это объявление оставлено для ручной проверки.</p>` : ''}${car.conflicts.length ? `<p class="warn-note">Есть противоречивые упоминания опций: ${escapeHTML(car.conflicts.map(key => optionMap.get(key).label).join(', '))}. Уточни у продавца.</p>` : ''}<div class="detail-gallery"><div><div class="gallery-main" id="gallery-main"></div><div class="gallery-thumbs">${car.images.map((image, index) => `<button type="button" data-image="${index}" aria-label="Фото ${index + 1}" class="${index === 0 ? 'active' : ''}"><img src="${escapeHTML(imageURL(image, 'mo-160'))}" alt="Фото ${index + 1}" loading="lazy"></button>`).join('')}</div></div><dl class="detail-specs">${specs.map(([label, value]) => `<dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value ?? 'не указано')}</dd>`).join('')}</dl></div>${duplicates.length ? `<section class="detail-section"><h3>Возможные дубли: сравни цены</h3><p>Совпали регистрация, пробег и мощность. Это не подтверждение совпадения автомобиля по VIN.</p><div class="duplicate-list">${duplicates.map(other => `<div class="duplicate-row"><div><strong>${money(other.price)} · ${escapeHTML(other.source)}</strong>${escapeHTML(other.title)}<br>${escapeHTML(other.seller ?? '')}</div><a href="${escapeHTML(other.url)}" target="_blank" rel="noopener noreferrer">Открыть ↗</a></div>`).join('')}</div></section>` : ''}${priceHistoryHTML(car)}${richnessHTML(car)}${equipmentSections(car)}<section class="detail-section"><h3>Описание продавца · оригинал</h3><pre class="original-text">${escapeHTML(car.description || 'Описание не заполнено')}</pre></section><details class="detail-section original-source"><summary>Исходный список оборудования <span>${car.equipment.length} пунктов</span></summary><div class="original-equipment">${car.equipment.length ? car.equipment.map(value => `<span class="option-pill">${escapeHTML(value)}</span>`).join('') : '<p>Отдельный список не заполнен продавцом.</p>'}</div></details><p class="detail-footnote">Снимок: ${escapeHTML(new Date(car.fetched_at).toLocaleString('ru-RU'))}. Цена и наличие могли измениться. Внешние фотографии загружаются с площадок объявлений.</p></div>`;
  renderGallery();
  imageFallbacks($('#detail-content'));
  const dialog = $('#detail-dialog');
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  $('#close-dialog').focus();
}

function renderGallery() {
  if (!activeCar) return;
  const images = activeCar.images;
  if (!images.length) { $('#gallery-main').textContent = 'Фотографии не опубликованы'; return; }
  galleryIndex = (galleryIndex + images.length) % images.length;
  $('#gallery-main').innerHTML = `<img src="${escapeHTML(images[galleryIndex])}" alt="${escapeHTML(activeCar.title)} — фото ${galleryIndex + 1}"><div class="gallery-nav"><button type="button" data-gallery="-1" aria-label="Предыдущее фото">‹</button><span>${galleryIndex + 1} / ${images.length}</span><button type="button" data-gallery="1" aria-label="Следующее фото">›</button></div>`;
  imageFallbacks($('#gallery-main'));
  $$('.gallery-thumbs button').forEach(button => button.classList.toggle('active', Number(button.dataset.image) === galleryIndex));
}

function downloadCSV() {
  const quote = value => {
    let content = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(content)) content = `'${content}`;
    return `"${content.replace(/"/g, '""')}"`;
  };
  const rows = [['Источник', 'Ссылка', 'Название', 'Цена EUR', 'Нетто EUR', 'Пробег км', 'Регистрация', 'Страна', 'Город', 'Продавец', 'Цилиндры', 'ДТП', 'Возможные дубли', 'Унифицированные опции', 'Жирность, баллы', 'Цена новой машины по заявлению продавца EUR', 'Описание оригинал'], ...filtered.map(car => [car.source, car.url, car.title, car.price, car.net_price, car.mileage, car.registration, countries[car.country] ?? car.country, car.city, car.seller, car.cylinders, car.accident, car.duplicate_group, Array.from(featureIds(car, controls().evidence)).map(id => optionMap.get(id).label).join('; '), carLuxury(car).total, car.newPrice?.value, car.description])];
  const blob = new Blob(['\uFEFF' + rows.map(row => row.map(quote).join(';')).join('\r\n')], {type: 'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'cayenne-filtered.csv';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast(`Выгружено ${filtered.length} объявлений`);
}

function bindEvents() {
  fields.forEach(id => $(`#${id}`).addEventListener('input', () => {
    clearTimeout(searchTimer);
    if (id === 'search') searchTimer = setTimeout(() => apply(), 180);
    else apply();
  }));
  $$('input[name="mode"]').forEach(input => input.addEventListener('change', () => apply()));
  $('#option-search').addEventListener('input', renderOptions);
  $('#option-list').addEventListener('change', event => { if (event.target.matches('input[type="checkbox"]')) toggleOption(event.target.value); });
  document.addEventListener('click', event => {
    const updateFilter = event.target.closest('[data-radar-filter]');
    if (updateFilter) { $('#updates').value = updateFilter.dataset.radarFilter; apply(); $('#results').scrollIntoView({block: 'start'}); return; }
    const help = event.target.closest('[data-help]');
    if (help) { showOption(help.dataset.help); return; }
    const use = event.target.closest('[data-use-option]');
    if (use) {
      $('#option-dialog').close();
      if ($('#detail-dialog').open) $('#detail-dialog').close();
      toggleOption(use.dataset.useOption);
      return;
    }
    const toggle = event.target.closest('[data-toggle]');
    if (toggle) toggleOption(toggle.dataset.toggle);
    const open = event.target.closest('[data-open]');
    if (open) showCar(open.dataset.open);
    const photo = event.target.closest('[data-image]');
    if (photo) { galleryIndex = Number(photo.dataset.image); renderGallery(); }
    const gallery = event.target.closest('[data-gallery]');
    if (gallery) { galleryIndex += Number(gallery.dataset.gallery); renderGallery(); }
  });
  $('#reset').addEventListener('click', reset);
  $('#empty-reset').addEventListener('click', reset);
  $('.brand').addEventListener('click', event => { event.preventDefault(); reset(); window.scrollTo({top: 0, behavior: 'smooth'}); });
  $('#load-more').addEventListener('click', () => { visibleLimit += 24; renderCards(); });
  $('#close-dialog').addEventListener('click', () => $('#detail-dialog').close());
  $('#detail-dialog').addEventListener('click', event => {
    if (event.target !== $('#detail-dialog')) return;
    const bounds = event.target.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.target.close();
  });
  $('#detail-dialog').addEventListener('close', () => lastFocused?.focus());
  $('#close-option-dialog').addEventListener('click', () => $('#option-dialog').close());
  $('#option-dialog').addEventListener('close', () => lastOptionFocus?.focus());
  $('#option-dialog').addEventListener('click', event => {
    if (event.target !== $('#option-dialog')) return;
    const bounds = event.target.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.target.close();
  });
  $('#export').addEventListener('click', downloadCSV);
  $('#sort-richest').addEventListener('click', () => { $('#sort').value = 'luxury-desc'; apply(); });
  $('#share').addEventListener('click', async () => {
    apply();
    try { await navigator.clipboard.writeText(location.href); toast('Ссылка с выбранными фильтрами скопирована'); }
    catch { toast('Скопируй адрес страницы из адресной строки — фильтры уже сохранены в ссылке'); }
  });
  window.addEventListener('hashchange', () => { setControls(readHash()); apply({updateHash: false}); });
}

async function init() {
  try {
    const response = await fetch('data.json', {cache: 'no-cache'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    dataset = await response.json();
    try {
      const radarResponse = await fetch('radar.json', {cache: 'no-cache'});
      if (!radarResponse.ok) throw new Error('Radar unavailable');
      const value = await radarResponse.json();
      radar = value.schema === 1 && value.listings && Array.isArray(value.events) ? value : null;
    } catch { radar = null; }
    if (dataset.schema !== 1 || !Array.isArray(dataset.cars) || !Array.isArray(dataset.catalogue)) throw new Error('Неверный формат данных');
    catalogue = dataset.catalogue.map(item => ({...item, searchText: fold([item.label, ...item.aliases, item.id === 'air_suspension' ? 'пневма пневмо' : ''].join(' '))})).sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    optionMap = new Map(catalogue.map(item => [item.id, item]));
    baselineIds = new Set((dataset.common_options ?? []).filter(id => optionMap.has(id)));
    cars = dataset.cars.map(car => ({...car, optionIds: new Set(Object.keys(car.features)), structuredIds: new Set(Object.keys(car.features).filter(id => car.features[id].some(row => ['equipment', 'attribute'].includes(row.kind)))), searchText: fold([car.title, car.description, car.seller, car.city, countries[car.country], ...car.equipment, ...Object.keys(car.features).map(id => optionMap.get(id)?.label)].join(' ')), repaired: car.accident?.startsWith('Отремонтированные'), registrationSort: car.registration?.split('/').reverse().join('-') ?? ''}));
    cars = cars.map(car => ({...car, luxury: luxuryScore(car), luxuryStructured: luxuryScore(car, 'structured'), newPrice: originalPrice(car.description)}));
    carMap = new Map(cars.map(car => [car.id, car]));
    $('#total').textContent = cars.length;
    $('#option-total').textContent = catalogue.length;
    $('#snapshot').textContent = `AutoScout24: ${radar?.last_success ? dateTime(radar.last_success) : 'ожидает проверки'} · mobile.de: сохранённый снимок`;
    renderRadar();
    $('#normalization-note').textContent = `${dataset.counts.raw_labels} исходных названий сведены к ${dataset.counts.canonical_list_options} опциям в списках. С учётом дополнительных характеристик и упоминаний в описаниях — ${catalogue.length} пунктов каталога.`;
    $('#country').innerHTML += Array.from(new Set(cars.map(car => car.country))).sort((a, b) => (countries[a] ?? a).localeCompare(countries[b] ?? b, 'ru')).map(code => `<option value="${escapeHTML(code)}">${escapeHTML(countries[code] ?? code)}</option>`).join('');
    const quick = ['air_suspension', 'rear_steering', 'pdcc', 'pasm', 'sport_chrono', 'bose', 'burmester', 'hud', 'camera_360', 'soft_close', 'seat_vent', 'panorama'];
    $('#quick-options').innerHTML = quick.filter(id => optionMap.has(id) && !baselineIds.has(id)).map(id => `<div class="quick-option"><button class="chip" type="button" data-toggle="${escapeHTML(id)}" aria-pressed="false">${escapeHTML(optionMap.get(id).label)}</button>${infoButton(id)}</div>`).join('');
    renderBaseline();
    if (matchMedia('(max-width: 700px)').matches) $('#filter-panel').open = false;
    setControls(readHash());
    bindEvents();
    apply({updateHash: false});
    renderOptions();
    $('#loading').hidden = true;
  } catch (error) {
    $('#loading').textContent = 'Не удалось загрузить подборку. Обнови страницу или проверь, что сайт запущен через HTTP, а не открыт как локальный файл.';
    $('#loading').className = 'error-box';
    $('#result-count').textContent = 'Ошибка загрузки';
    $('#result-note').textContent = String(error.message).slice(0, 150);
    $('#export').disabled = true;
  }
}

init();
