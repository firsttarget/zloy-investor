'use strict';

// Демо-режим без API-ключа: детерминированные эвристики вместо модели.
// Нужен, чтобы интерфейс и тесты работали без ключа. В интерфейсе показывается плашка «демо-режим».
const { CRITERIA } = require('./criteria');
const { fallbackAdvice } = require('./advice_library');
const { detectManipulation } = require('./guards');

const KEYWORDS = {
  c1: /проблем|боль|клиент|пользовател|интервью|опрос/i,
  c2: /подписк|платит|плат[её]ж|комисси|тариф|модел|₽|руб/i,
  c3: /рынок|рынка|конкурент|аналог|альтернатив|tam|sam|som/i,
  c4: /выручк|затрат|себестоим|cac|ltv|юнит|маржа|прибыл/i,
  c5: /патент|ооо|(^|\s)ип(\s|$)|регистрац|товарн\p{L}+ знак|программ\p{L}+ для эвм|лиценз/iu,
  c6: /продаж|продали|клиент\p{L}* плат|предзаказ|пилот|договор|оплатил/iu,
  c7: /риск|гипотез|если не|угроз/i,
  c8: /безубыточ|окупаем|в ноль|месяц|год|горизонт/i,
  c9: /уникальн|отлича|в отличие|технолог|впервые|запатент/i,
  c10: /инвестиц|привлеч|раунд|грант|нужно\s+\d|млн|доля/i,
};
const ACTION = /провели|продали|запустили|зарегистрир|подписали|заключили|оплатил|получили|собрали/i;

function sentences(text) {
  return String(text || '')
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstWords(s, n) {
  return s.split(/\s+/).slice(0, n).join(' ');
}

function scoreFor(id, text) {
  const hit = sentences(text).find((s) => KEYWORDS[id].test(s));
  if (!hit) return { score: 0, evidence: '' };
  const digits = /\d/.test(hit);
  let score = 1;
  if (digits) score = 2;
  if (digits && ACTION.test(hit)) score = 3;
  return { score, evidence: firstWords(hit, 18) };
}

function snippet(text) {
  const s = sentences(text).find((x) => x.length > 25) || String(text).slice(0, 80);
  return firstWords(s, 9).replace(/[.,;:!?]+$/, '');
}

function respond({ name, ctx = {} }) {
  if (name === 'analysis') {
    const facts = sentences(ctx.pitch).filter((s) => /\d/.test(s)).slice(0, 6);
    return {
      is_pitch: true,
      product_summary: firstWords(sentences(ctx.pitch)[0] || '', 20),
      facts,
      gaps: CRITERIA.filter((c) => scoreFor(c.id, ctx.pitch).score < 2).map((c) => `Слабо: ${c.name}`).slice(0, 6),
      manipulation: detectManipulation(ctx.pitch || ''),
    };
  }

  if (name === 'question') {
    const last = ctx.lastAnswer || '';
    let quality = 'none';
    let reaction = 'Читал. Начнём с главного.';
    if (ctx.n > 1) {
      if (detectManipulation(last)) {
        quality = 'manipulation';
        reaction = 'Оценку ставят факты, а не просьбы.';
      } else if (/друз|знаком|однокурсник/i.test(last)) {
        quality = 'weak';
        reaction = 'Друзья — не клиенты.';
      } else if (/\d/.test(last)) {
        quality = 'strong';
        reaction = 'Принято.';
      } else {
        quality = 'weak';
        reaction = 'Без цифр это мнение, а не факт.';
      }
    }
    const base = ctx.slot.bank[0].replace(/\s*\(\d+\)\s*$/, '');
    const anchor = ctx.n === 1 ? `Вы пишете: «${snippet(ctx.pitch)}». ` : '';
    return { reaction, question: `${anchor}${base}`, answer_quality: quality, distress: false };
  }

  if (name === 'evaluation') {
    const all = `${ctx.pitch}\n${ctx.answers.join('\n')}`;
    const criteria = CRITERIA.map((c) => {
      const p = scoreFor(c.id, ctx.pitch);
      const f = scoreFor(c.id, all);
      const final = Math.max(p.score, f.score);
      return {
        id: c.id,
        score_pitch: p.score,
        score_final: final,
        evidence_pitch: p.evidence,
        evidence: final === f.score ? f.evidence : p.evidence,
        comment: final < 3 ? `Не хватает доказательств: ${c.hint}.` : 'Подтверждено действиями.',
      };
    });
    return {
      criteria,
      verdict: 'Демо-режим: оценка по ключевым словам. Подключите API-ключ, чтобы инвестор читал питч по-настоящему.',
    };
  }

  if (name === 'advice') {
    return { advice: fallbackAdvice(ctx.targets) };
  }

  throw new Error(`mock: неизвестный запрос ${name}`);
}

module.exports = { respond };
