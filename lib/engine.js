'use strict';

const crypto = require('crypto');
const config = require('./config');
const { CRITERIA, SCALE, decisionFor } = require('./criteria');
const { getPersona, slotsFor, publicPersona } = require('./personas');
const prompts = require('./prompts');
const schemas = require('./schemas');
const { callJSON } = require('./llm');
const guards = require('./guards');
const { fallbackAdvice } = require('./advice_library');

const TOTAL_QUESTIONS = 5;
const sessions = new Map();

class UserError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// ---------- Хранилище сессий (в памяти, с TTL). Текст питча нигде не логируется. ----------

function cleanup() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.updatedAt > config.limits.sessionTtlMs) sessions.delete(id);
  }
}
setInterval(cleanup, 5 * 60 * 1000).unref();

function getSession(id) {
  if (typeof id !== 'string' || !sessions.has(id)) {
    throw new UserError(404, 'Сессия не найдена или устарела. Начните заново.');
  }
  return sessions.get(id);
}

// ---------- Вспомогательное ----------

function persona() {
  return getPersona(config.investor);
}

function transcriptText(s) {
  if (!s.turns.length) return '(разговор ещё не начался)';
  return s.turns
    .map((t) => `Инвестор (вопрос ${t.n}): ${t.question}\nСтудент: ${t.answer === undefined ? '(ещё не ответил)' : prompts.stripTags(t.answer) || '(пустой ответ)'}`)
    .join('\n\n');
}

function listText(arr) {
  return arr && arr.length ? arr.map((x) => `- ${x}`).join('\n') : '- (нет)';
}

function daysLabel(d) {
  const n = Number(d);
  if (n === 1) return '1 день';
  if (n >= 2 && n <= 4) return `${n} дня`;
  if (n >= 5) return `${n} дней`;
  return 'несколько дней';
}

// ---------- Шаги сценария. Порядок ведёт код, а не модель: ровно 5 вопросов, ровно 3 совета. ----------

async function askQuestion(s) {
  const n = s.turns.length + 1;
  const slot = slotsFor(s.persona)[n - 1];
  const last = s.turns[s.turns.length - 1];
  const user = prompts.render('question.md', {
    n,
    product_summary: prompts.stripTags(s.analysis.product_summary),
    facts: listText(s.analysis.facts.map(prompts.stripTags)),
    gaps: listText(s.analysis.gaps.map(prompts.stripTags)),
    pitch: prompts.stripTags(s.pitch),
    transcript: transcriptText(s),
    last_answer_block: last
      ? `Последний ответ студента (на вопрос ${last.n}):\n<answer>\n${prompts.stripTags(last.answer)}\n</answer>`
      : 'Это первый вопрос, ответов ещё не было.',
    topic: slot.topic,
    criteria: slot.criteria.map((id) => CRITERIA.find((c) => c.id === id).name).join(', '),
    bank: listText(slot.bank),
  });

  const out = await callJSON({
    name: 'question',
    system: prompts.systemPrompt(s.persona.id),
    user,
    schema: schemas.question,
    maxTokens: 400,
    ctx: { n, slot, pitch: s.pitch, lastAnswer: last && last.answer },
  });

  const question = String(out.question || '').trim() || slot.bank[0].replace(/\s*\(\d+\)\s*$/, '');
  const reaction = String(out.reaction || '').trim();
  if (last) last.quality = out.answer_quality || 'weak';
  s.turns.push({ n, topic: slot.topic, question, reaction });
  return { n, total: TOTAL_QUESTIONS, topic: slot.topic, reaction, question };
}

function computeScores(s, raw) {
  const sourceAll = `${s.pitch}\n${s.turns.map((t) => t.answer || '').join('\n')}`;
  const byId = new Map((raw.criteria || []).map((c) => [c.id, c]));
  const w = s.persona.weights;
  let total = 0;
  let totalPitch = 0;

  const rows = CRITERIA.map((c) => {
    const r = byId.get(c.id) || {};
    let pitchScore = clampScore(r.score_pitch);
    let finalScore = clampScore(r.score_final);
    let evidence = String(r.evidence || '').trim();
    let verified = true;

    // Антигаллюцинация: балл выше 1 только при дословной цитате из текста студента.
    if (finalScore > 0 && !guards.evidenceFound(evidence, sourceAll)) {
      verified = false;
      evidence = '';
      finalScore = Math.min(finalScore, 1);
    }
    if (pitchScore > 0 && !guards.evidenceFound(r.evidence, s.pitch)) {
      pitchScore = Math.min(pitchScore, 1);
    }

    total += (w[c.id] * finalScore) / 3;
    totalPitch += (w[c.id] * pitchScore) / 3;
    return {
      id: c.id,
      name: c.name,
      weight: w[c.id],
      scorePitch: pitchScore,
      score: finalScore,
      level: SCALE[finalScore].label,
      evidence,
      verified,
      comment: String(r.comment || '').trim(),
    };
  });

  return { rows, total: Math.round(total), totalPitch: Math.round(totalPitch) };
}

function clampScore(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(0, Math.min(3, n)) : 0;
}

// Три совета закрывают три самых «дорогих» провала: вес × недостающие баллы.
function pickTargets(rows) {
  return [...rows]
    .sort((a, b) => b.weight * (3 - b.score) - a.weight * (3 - a.score) || b.weight - a.weight)
    .slice(0, 3)
    .map((r) => r.id);
}

async function makeAdvice(s, targets) {
  const targetsText = targets
    .map((id, i) => {
      const c = CRITERIA.find((x) => x.id === id);
      const row = s.result.rows.find((r) => r.id === id);
      return `${i + 1}. ${id} — ${c.name} (сейчас ${row.score}/3: ${row.comment || c.hint})`;
    })
    .join('\n');

  const base = {
    name: 'advice',
    system: prompts.systemPrompt(s.persona.id),
    schema: schemas.advice,
    maxTokens: 1200,
    ctx: { targets },
  };
  const user = prompts.render('advice.md', {
    days_left: daysLabel(s.daysLeft),
    pitch: prompts.stripTags(s.pitch),
    transcript: transcriptText(s),
    targets: targetsText,
  });

  try {
    let out = await callJSON({ ...base, user });
    let problems = guards.adviceProblems(out.advice, targets);
    if (problems.length) {
      out = await callJSON({ ...base, user: `${user}\n\nПрошлый вариант отклонён: ${problems.join('; ')}. Исправь.` });
      problems = guards.adviceProblems(out.advice, targets);
    }
    if (!problems.length) return { advice: orderAdvice(out.advice, targets), source: 'model' };
  } catch (e) {
    console.error(JSON.stringify({ event: 'advice_error', message: e.message }));
  }
  return { advice: fallbackAdvice(targets), source: 'library' };
}

function orderAdvice(list, targets) {
  return targets.map((id) => {
    const a = list.find((x) => x.criterion_id === id);
    return {
      criterion_id: id,
      action: String(a.action).trim(),
      time: String(a.time).trim(),
      result: String(a.result || '').trim(),
      stage_line: String(a.stage_line).trim(),
    };
  });
}

async function finish(s) {
  const answers = s.turns.map((t) => t.answer || '');
  const user = prompts.render('evaluate.md', {
    pitch: prompts.stripTags(s.pitch),
    transcript: transcriptText(s),
    scale: SCALE.map((x) => `${x.score} — ${x.label}: ${x.rule}`).join('\n'),
    criteria: CRITERIA.map((c) => `${c.id}. ${c.name}: ${c.hint}`).join('\n'),
  });

  const raw = await callJSON({
    name: 'evaluation',
    system: prompts.systemPrompt(s.persona.id),
    user,
    schema: schemas.evaluation,
    maxTokens: 3000,
    ctx: { pitch: s.pitch, answers },
  });

  const scores = computeScores(s, raw);
  s.result = {
    total: scores.total,
    totalPitch: scores.totalPitch,
    decision: decisionFor(scores.total),
    rows: scores.rows,
    verdict: String(raw.verdict || '').trim(),
    manipulationNoticed: s.manipulation || s.turns.some((t) => t.quality === 'manipulation'),
    avgAnswerSeconds: Math.round(s.turns.reduce((a, t) => a + (t.seconds || 0), 0) / s.turns.length),
  };
  const targets = pickTargets(scores.rows);
  const adv = await makeAdvice(s, targets);
  s.result.advice = adv.advice;
  s.stage = 'done';

  // Анонимное событие для метрик (без текста питча и ответов).
  console.log(
    JSON.stringify({
      event: 'session_completed',
      persona: s.persona.id,
      total: s.result.total,
      totalPitch: s.result.totalPitch,
      previousTotal: s.previousTotal,
      round: s.round,
      adviceSource: adv.source,
    }),
  );
  return s.result;
}

// ---------- Публичный API движка ----------

async function start({ pitch, daysLeft, previousTotal, round }) {
  if (sessions.size >= config.limits.maxSessions) cleanup();
  if (sessions.size >= config.limits.maxSessions) throw new UserError(503, 'Тренажёр перегружен. Попробуйте через минуту.');

  const { text, truncated } = guards.clean(pitch, config.limits.pitchMax);
  const problem = guards.checkPitch(text);
  if (problem) return { status: 'rejected', ...problem };

  const p = persona();
  const s = {
    id: crypto.randomUUID(),
    persona: p,
    pitch: text,
    daysLeft: Number(daysLeft) || 3,
    previousTotal: Number.isFinite(Number(previousTotal)) ? Math.max(0, Math.min(100, Number(previousTotal))) : null,
    round: Math.max(1, Math.min(20, Number(round) || 1)),
    turns: [],
    stage: 'questions',
    busy: true,
    manipulation: guards.detectManipulation(text),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  try {
    const analysis = await callJSON({
      name: 'analysis',
      system: prompts.systemPrompt(p.id),
      user: prompts.render('analyze_pitch.md', { pitch: prompts.stripTags(text) }),
      schema: schemas.analysis,
      maxTokens: 1200,
      ctx: { pitch: text },
    });
    if (!analysis.is_pitch) {
      return {
        status: 'rejected',
        code: 'not_pitch',
        message: 'Я не вижу здесь проекта. Опишите продукт, клиента и что уже сделано.',
        checklist: guards.PITCH_CHECKLIST,
      };
    }
    s.analysis = {
      product_summary: String(analysis.product_summary || ''),
      facts: (analysis.facts || []).map(String).slice(0, 10),
      gaps: (analysis.gaps || []).map(String).slice(0, 6),
    };
    s.manipulation = s.manipulation || Boolean(analysis.manipulation);
    sessions.set(s.id, s);
    const q = await askQuestion(s);
    if (s.manipulation && q.n === 1) q.reaction = `Оценку ставят факты, а не просьбы. ${q.reaction}`.trim();
    return {
      status: 'ok',
      sessionId: s.id,
      persona: publicPersona(p),
      truncated,
      question: q,
    };
  } finally {
    s.busy = false;
    s.updatedAt = Date.now();
  }
}

async function answer({ sessionId, answer: raw, seconds }) {
  const s = getSession(sessionId);
  if (s.stage === 'done') return { status: 'done', result: s.result };
  if (s.busy) throw new UserError(409, 'Инвестор ещё думает над прошлым ответом.');

  const { text } = guards.clean(raw, config.limits.answerMax);
  if (!text) throw new UserError(400, 'Напишите ответ. Если не знаете — так и скажите: «не знаю, проверю».');

  // Признаки отчаяния: выходим из роли и не засчитываем ответ.
  if (guards.detectDistress(text)) {
    return { status: 'support', message: guards.SUPPORT_MESSAGE };
  }

  const current = s.turns[s.turns.length - 1];
  current.answer = text;
  current.seconds = Math.max(0, Math.min(3600, Math.round(Number(seconds) || 0)));
  if (guards.detectManipulation(text)) current.quality = 'manipulation';

  s.busy = true;
  try {
    if (s.turns.length < TOTAL_QUESTIONS) {
      const q = await askQuestion(s);
      if (current.quality === 'manipulation' && !/факты/i.test(q.reaction)) {
        q.reaction = 'Оценку ставят факты, а не просьбы.';
      }
      return { status: 'ok', question: q };
    }
    const result = await finish(s);
    return { status: 'done', result };
  } catch (e) {
    // Откатываем ответ, чтобы студент мог отправить его ещё раз.
    if (s.stage !== 'done') {
      current.answer = undefined;
      if (s.turns.length > current.n) s.turns.length = current.n;
    }
    throw e;
  } finally {
    s.busy = false;
    s.updatedAt = Date.now();
  }
}

function info() {
  return {
    persona: publicPersona(persona()),
    mode: config.provider === 'mock' ? 'demo' : 'live',
    totalQuestions: TOTAL_QUESTIONS,
    limits: { pitchMin: config.limits.pitchMin, pitchMax: config.limits.pitchMax, answerMax: config.limits.answerMax },
    criteria: CRITERIA.map((c) => ({ id: c.id, name: c.name, short: c.short })),
  };
}

module.exports = { start, answer, info, UserError, _sessions: sessions, _computeScores: computeScores, _pickTargets: pickTargets };
