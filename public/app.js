'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const state = { sessionId: null, cfg: null, persona: null, pitch: '', daysLeft: 3, result: null, askedAt: 0, timerId: null, busy: false };

  // ---------- localStorage: только удобства на этом устройстве, всё в try/catch ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* приватный режим */ }
    },
  };

  // ---------- Сеть ----------
  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* пусто */ }
    if (!res.ok) throw new Error(data.error || 'Что-то пошло не так. Попробуйте ещё раз.');
    return data;
  }

  // ---------- Экраны ----------
  function show(name) {
    for (const s of ['intro', 'chat', 'result']) $(`screen-${s}`).hidden = s !== name;
    window.scrollTo(0, 0);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text; // только textContent: вывод модели никогда не вставляется как HTML
    return e;
  }

  function showError(box, message, checklist) {
    box.textContent = '';
    box.append(el('div', '', message));
    if (checklist && checklist.length) {
      const ul = el('ul');
      checklist.forEach((x) => ul.append(el('li', '', x)));
      box.append(ul);
    }
    box.hidden = false;
  }

  // ---------- Экран 1 ----------
  function fillPersona(p) {
    $('persona-avatar').textContent = p.avatar;
    $('chat-avatar').textContent = p.avatar;
    $('persona-name').textContent = p.name;
    $('chat-name').textContent = `Злой инвестор · ${p.name}`;
    $('persona-who').textContent = p.who;
    $('persona-wants').textContent = p.wants;
    $('persona-fears').textContent = p.fears;
    $('persona-behavior').textContent = p.behavior;
  }

  function renderRoundBanner() {
    const last = store.get('zi:last', null);
    const banner = $('round-banner');
    if (!last) { banner.hidden = true; return; }
    banner.textContent = `Раунд ${last.round + 1}. В прошлый раз: ${last.total}/100. Сделайте задачи из плана и проверьте, вырос ли балл.`;
    banner.hidden = false;
  }

  function updateCounter() {
    $('pitch-counter').textContent = `${$('pitch').value.length} / ${state.cfg ? state.cfg.limits.pitchMax : 6000}`;
  }

  async function startSession(e) {
    if (e) e.preventDefault();
    if (state.busy) return;
    const pitch = $('pitch').value.trim();
    const errBox = $('pitch-error');
    errBox.hidden = true;
    if (!pitch) return showError(errBox, 'Питч пустой. Инвестору нечего разносить.');

    state.busy = true;
    const btn = $('start-btn');
    btn.disabled = true;
    btn.textContent = 'Инвестор читает питч…';
    store.set('zi:draft', pitch);

    const last = store.get('zi:last', null);
    try {
      const data = await api('/api/start', {
        pitch,
        daysLeft: Number($('days').value),
        previousTotal: last ? last.total : null,
        round: last ? last.round + 1 : 1,
      });
      if (data.status === 'rejected') return showError(errBox, data.message, data.checklist);

      state.sessionId = data.sessionId;
      state.pitch = pitch;
      state.daysLeft = Number($('days').value);
      $('messages').textContent = '';
      show('chat');
      if (data.truncated) addSystem('Питч длинный: инвестор прочитал первые 6000 символов. На сцене у вас всё равно 3 минуты.');
      addSystem('Отвечайте так, как ответили бы жюри: коротко и с цифрами.');
      renderQuestion(data.question);
    } catch (err) {
      showError(errBox, err.message);
    } finally {
      state.busy = false;
      btn.disabled = false;
      btn.textContent = 'Начать прожарку';
    }
  }

  // ---------- Экран 2 ----------
  function addSystem(text) {
    $('messages').append(el('div', 'msg system', text));
  }

  function addUser(text) {
    $('messages').append(el('div', 'msg user', text));
    scrollDown();
  }

  function renderProgress(n, total) {
    const box = $('progress');
    box.textContent = '';
    for (let i = 1; i <= total; i++) {
      box.append(el('span', i < n ? 'done' : i === n ? 'current' : ''));
    }
  }

  function renderQuestion(q) {
    removeTyping();
    const m = el('div', 'msg bot');
    m.append(el('span', 'qnum', `Вопрос ${q.n} из ${q.total}`));
    if (q.reaction) m.append(el('span', 'reaction', q.reaction));
    m.append(document.createTextNode(q.question));
    $('messages').append(m);
    renderProgress(q.n, q.total);
    $('topic-label').textContent = q.topic;
    $('chat-status').textContent = 'ждёт ответа';
    startTimer();
    scrollDown();
    $('answer').focus();
  }

  function showTyping() {
    const t = el('div', 'msg bot typing-msg');
    const dots = el('span', 'typing');
    dots.append(el('i'), el('i'), el('i'));
    t.append(dots);
    $('messages').append(t);
    $('chat-status').textContent = 'печатает…';
    scrollDown();
  }

  function removeTyping() {
    document.querySelectorAll('.typing-msg').forEach((n) => n.remove());
  }

  function scrollDown() {
    requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }));
  }

  function startTimer() {
    stopTimer();
    state.askedAt = Date.now();
    const t = $('timer');
    const tick = () => {
      const s = Math.floor((Date.now() - state.askedAt) / 1000);
      t.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      t.classList.toggle('late', s > 60);
    };
    tick();
    state.timerId = setInterval(tick, 1000);
  }

  function stopTimer() {
    if (state.timerId) clearInterval(state.timerId);
    state.timerId = null;
  }

  async function sendAnswer(e) {
    if (e) e.preventDefault();
    if (state.busy) return;
    stopListening();
    const box = $('answer');
    const text = box.value.trim();
    const errBox = $('answer-error');
    errBox.hidden = true;
    if (!text) return showError(errBox, 'Напишите ответ. Если не знаете — так и скажите: «не знаю, проверю».');

    state.busy = true;
    $('send-btn').disabled = true;
    const seconds = Math.round((Date.now() - state.askedAt) / 1000);
    stopTimer();
    addUser(text);
    box.value = '';
    showTyping();

    try {
      const data = await api('/api/answer', { sessionId: state.sessionId, answer: text, seconds });
      if (data.status === 'support') {
        removeTyping();
        $('messages').append(el('div', 'msg support', data.message));
        $('chat-status').textContent = 'на паузе';
        startTimer();
        return;
      }
      if (data.status === 'ok') return renderQuestion(data.question);
      if (data.status === 'done') {
        removeTyping();
        renderResult(data.result);
      }
    } catch (err) {
      removeTyping();
      // Возвращаем текст, чтобы ответ не потерялся.
      const lastUser = [...document.querySelectorAll('.msg.user')].pop();
      if (lastUser) lastUser.remove();
      box.value = text;
      showError(errBox, err.message);
      startTimer();
    } finally {
      state.busy = false;
      $('send-btn').disabled = false;
    }
  }

  // Ответ голосом: тренирует «произнести вслух». Работает в браузерах с Web Speech API (Chrome, Edge, Safari).
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;
  function setupVoice() {
    if (!Recognition) return;
    $('mic-btn').hidden = false;
    $('mic-btn').addEventListener('click', () => (recognizer ? stopListening() : startListening()));
  }
  function startListening() {
    try {
      recognizer = new Recognition();
      recognizer.lang = 'ru-RU';
      recognizer.interimResults = false;
      recognizer.continuous = true;
      const base = $('answer').value;
      let heard = '';
      recognizer.onresult = (ev) => {
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) heard += ev.results[i][0].transcript + ' ';
        }
        $('answer').value = `${base} ${heard}`.trim();
      };
      recognizer.onend = () => { recognizer = null; $('mic-btn').classList.remove('listening'); };
      recognizer.onerror = recognizer.onend;
      recognizer.start();
      $('mic-btn').classList.add('listening');
    } catch {
      recognizer = null;
    }
  }
  function stopListening() {
    if (recognizer) { try { recognizer.stop(); } catch { /* уже остановлен */ } }
  }

  // ---------- Экран 3 ----------
  function renderResult(r) {
    state.result = r;
    stopTimer();
    show('result');

    $('score-total').textContent = r.total;
    $('score-ring').style.setProperty('--p', r.total);
    const d = $('decision');
    d.textContent = r.decision.label;
    d.className = `decision ${r.decision.level}`;

    const delta = r.total - r.totalPitch;
    $('score-delta').textContent =
      `По одному питчу: ${r.totalPitch}/100. После ответов: ${r.total}/100 (${delta >= 0 ? '+' : ''}${delta}).`;

    const last = store.get('zi:last', null);
    if (last) {
      const rd = r.total - last.total;
      $('round-delta').textContent = `Прошлый раунд: ${last.total}/100 → сейчас ${r.total}/100 (${rd >= 0 ? '+' : ''}${rd}).`;
    } else {
      $('round-delta').textContent = '';
    }
    store.set('zi:last', { total: r.total, round: last ? last.round + 1 : 1, at: Date.now() });

    $('verdict').textContent = r.verdict || '';
    $('verdict').hidden = !r.verdict;
    $('manipulation-note').hidden = !r.manipulationNoticed;
    $('avg-time').textContent = r.avgAnswerSeconds ? `Среднее время на ответ: ${r.avgAnswerSeconds} сек. На сцене ориентируйтесь на 30–60 секунд.` : '';

    const names = Object.fromEntries(state.cfg.criteria.map((c) => [c.id, c.name]));
    store.set('zi:done', {}); // новый раунд — новый план
    const doneMap = {};
    const list = $('advice');
    list.textContent = '';
    r.advice.forEach((a, i) => {
      const li = el('li');
      const head = el('div', 'adv-head');
      head.append(el('span', 'adv-crit', names[a.criterion_id] || ''), el('span', 'adv-time', `⏱ ${a.time}`));
      li.append(head, el('p', 'adv-action', a.action));
      if (a.result) li.append(el('p', 'adv-result', `На руках: ${a.result}`));
      const line = el('p', 'adv-line', 'Скажете на сцене: ');
      line.append(el('q', '', a.stage_line));
      li.append(line);
      const key = `${a.criterion_id}:${i}`;
      const label = el('label', 'adv-check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = Boolean(doneMap[key]);
      li.classList.toggle('done', cb.checked);
      cb.addEventListener('change', () => {
        const m = store.get('zi:done', {});
        m[key] = cb.checked;
        store.set('zi:done', m);
        li.classList.toggle('done', cb.checked);
      });
      label.append(cb, document.createTextNode('Сделано'));
      li.append(label);
      list.append(li);
    });

    const box = $('criteria');
    box.textContent = '';
    r.rows.forEach((c) => {
      const row = el('div', 'crit');
      const top = el('div', 'crit-top');
      const score = el('span', 'crit-score');
      if (c.score !== c.scorePitch) {
        score.append(el('span', c.score > c.scorePitch ? 'up' : 'down', `${c.scorePitch}→`));
      }
      score.append(document.createTextNode(`${c.score}/3`));
      top.append(el('span', 'crit-name', c.name), score);
      const bar = el('div', 'bar');
      const fill = el('i');
      fill.style.width = `${(c.score / 3) * 100}%`;
      bar.append(fill);
      row.append(top, bar, el('div', 'crit-meta', `${c.level} · вес ${c.weight}${c.comment ? ' · ' + c.comment : ''}`));
      if (c.evidence) {
        const ev = el('div', 'crit-evidence', 'Основание: ');
        ev.append(el('q', '', c.evidence));
        row.append(ev);
      }
      box.append(row);
    });
  }

  function planText() {
    const r = state.result;
    const names = Object.fromEntries(state.cfg.criteria.map((c) => [c.id, c.name]));
    const lines = [`Злой инвестор (${state.persona.name}): ${r.total}/100 — ${r.decision.label}`, '', 'План до выступления:'];
    r.advice.forEach((a, i) => {
      lines.push(`${i + 1}. [${names[a.criterion_id]}] ${a.action} (${a.time})`);
      if (a.result) lines.push(`   На руках: ${a.result}`);
      lines.push(`   На сцене: «${a.stage_line}»`);
    });
    return lines.join('\n');
  }

  async function copyPlan() {
    const btn = $('copy-btn');
    try {
      await navigator.clipboard.writeText(planText());
      btn.textContent = 'Скопировано';
    } catch {
      btn.textContent = 'Не удалось скопировать';
    }
    setTimeout(() => (btn.textContent = 'Скопировать план'), 2000);
  }

  function again() {
    $('pitch').value = state.pitch;
    updateCounter();
    renderRoundBanner();
    show('intro');
  }

  function fresh() {
    $('pitch').value = '';
    store.set('zi:draft', '');
    try { localStorage.removeItem('zi:last'); localStorage.removeItem('zi:done'); } catch { /* ок */ }
    updateCounter();
    renderRoundBanner();
    show('intro');
  }

  // ---------- Старт ----------
  async function init() {
    try {
      state.cfg = await api('/api/config');
    } catch {
      state.cfg = { persona: null, mode: 'live', limits: { pitchMax: 6000 }, criteria: [] };
    }
    if (state.cfg.persona) {
      state.persona = state.cfg.persona;
      fillPersona(state.cfg.persona);
    }
    $('mode-badge').hidden = state.cfg.mode !== 'demo';
    $('pitch').value = store.get('zi:draft', '') || '';
    updateCounter();
    renderRoundBanner();
    setupVoice();

    $('pitch').addEventListener('input', updateCounter);
    $('pitch-form').addEventListener('submit', startSession);
    $('answer-form').addEventListener('submit', sendAnswer);
    $('answer').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) sendAnswer(e);
    });
    $('sample-btn').addEventListener('click', () => {
      const list = window.SAMPLE_PITCHES || [];
      $('pitch').value = list[Math.floor(Math.random() * list.length)] || '';
      updateCounter();
    });
    $('copy-btn').addEventListener('click', copyPlan);
    $('again-btn').addEventListener('click', again);
    $('new-btn').addEventListener('click', fresh);
  }

  init();
})();
