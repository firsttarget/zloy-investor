'use strict';

const { CRITERIA_IDS } = require('./criteria');

// JSON-схемы ответов модели. Для Claude они передаются как инструмент с принудительным вызовом,
// для OpenAI-совместимых API — как описание формата в JSON-режиме. Код всё равно валидирует результат.

const analysis = {
  type: 'object',
  properties: {
    is_pitch: { type: 'boolean' },
    product_summary: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' }, maxItems: 10 },
    gaps: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    manipulation: { type: 'boolean' },
  },
  required: ['is_pitch', 'product_summary', 'facts', 'gaps', 'manipulation'],
};

const question = {
  type: 'object',
  properties: {
    reaction: { type: 'string' },
    question: { type: 'string' },
    answer_quality: { type: 'string', enum: ['strong', 'weak', 'evasive', 'manipulation', 'none'] },
    distress: { type: 'boolean' },
  },
  required: ['reaction', 'question', 'answer_quality', 'distress'],
};

const evaluation = {
  type: 'object',
  properties: {
    criteria: {
      type: 'array',
      minItems: 10,
      maxItems: 10,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', enum: CRITERIA_IDS },
          score_pitch: { type: 'integer', minimum: 0, maximum: 3 },
          score_final: { type: 'integer', minimum: 0, maximum: 3 },
          // Две цитаты, потому что код проверяет два балла из разных источников:
          // evidence_pitch — только из питча, evidence — из питча или ответов.
          evidence_pitch: { type: 'string' },
          evidence: { type: 'string' },
          comment: { type: 'string' },
        },
        required: ['id', 'score_pitch', 'score_final', 'evidence_pitch', 'evidence', 'comment'],
      },
    },
    verdict: { type: 'string' },
  },
  required: ['criteria', 'verdict'],
};

const advice = {
  type: 'object',
  properties: {
    advice: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          criterion_id: { type: 'string', enum: CRITERIA_IDS },
          action: { type: 'string' },
          time: { type: 'string' },
          result: { type: 'string' },
          stage_line: { type: 'string' },
        },
        required: ['criterion_id', 'action', 'time', 'result', 'stage_line'],
      },
    },
  },
  required: ['advice'],
};

module.exports = { analysis, question, evaluation, advice };
