'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'prompts');
const cache = new Map();

function load(name) {
  if (!cache.has(name)) {
    cache.set(name, fs.readFileSync(path.join(DIR, name), 'utf8'));
  }
  return cache.get(name);
}

// Подстановка {{var}}. Значения вставляются как есть: пользовательский текст оборачивается
// в теги <pitch>/<answer>/<transcript> в самих шаблонах, а здесь из него вырезаются
// закрывающие теги, чтобы студент не мог «выйти» из блока данных.
function render(name, vars) {
  return load(name).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

function stripTags(text) {
  return String(text || '').replace(/<\/?\s*(pitch|answer|transcript|system|instructions?)[^>]*>/gi, '');
}

function systemPrompt(personaId) {
  return render('system_base.md', { persona: load(`personas/${personaId}.md`) });
}

module.exports = { render, load, stripTags, systemPrompt };
