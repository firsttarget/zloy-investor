'use strict';

const config = require('./config');

// Очистка ввода: убираем управляющие символы, нормализуем пробелы, режем длину.
function clean(text, max) {
  let s = typeof text === 'string' ? text : '';
  s = s.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g, '');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const truncated = s.length > max;
  return { text: truncated ? s.slice(0, max) : s, truncated };
}

const PITCH_CHECKLIST = [
  'Что за продукт — одним предложением',
  'Для кого: опишите одного конкретного клиента',
  'Какую проблему решаете и как её решают сейчас',
  'Кто платит, сколько и за что',
  'Что уже сделали: интервью, пилоты, продажи (с цифрами)',
  'Команда и сколько времени тратите на проект',
];

function letterRatio(s) {
  if (!s) return 0;
  const letters = (s.match(/[a-zа-яё]/gi) || []).length;
  return letters / s.replace(/\s/g, '').length;
}

function wordCount(s) {
  return (s.match(/[a-zа-яё0-9]{2,}/gi) || []).length;
}

// В JS \w не ловит кириллицу, поэтому используем \p{L} с флагом u.
const MANIPULATION = [
  /(постав|выстав|дай|начисл)\p{L}*\s+(мне\s+|нам\s+)?(10|100|десять|сто|максим|высш|отличн|пятёрк|пятерк)/iu,
  /(высш|максимальн)\p{L}*\s+балл/iu,
  /игнорир\p{L}*|забудь\s+(все\s+)?(предыдущ|инструкц|правил)/iu,
  /ignore\s+(all\s+|any\s+)?(previous|prior|above)?\s*instructions?/iu,
  /(system|системн\p{L}*)\s+(prompt|промт|промпт)|покажи\s+(свой\s+)?(промт|промпт|инструкц)/iu,
  /ты\s+(теперь|больше\s+не)|you\s+are\s+now|act\s+as|притворись/iu,
  /\bjailbreak\b|\bDAN\b/u,
];

function detectManipulation(s) {
  return MANIPULATION.some((re) => re.test(s));
}

const DISTRESS = [
  /не\s+хочу\s+жить/i,
  /хочу\s+(умереть|исчезнуть)/i,
  /покончить\s+с\s+(собой|жизнью)/i,
  /я\s+(полное\s+)?(ничтожество|никчёмн|никчемн|бездарь)/iu,
  /(всё|все)\s+бессмысленно/i,
];

function detectDistress(s) {
  return DISTRESS.some((re) => re.test(s));
}

const SUPPORT_MESSAGE =
  'Выхожу из роли инвестора. Жёсткие вопросы здесь — про проект, а не про вас: дыры в проекте закрываются за пару дней, и именно для этого тренажёр. ' +
  'Сейчас нормально сделать перерыв. Если тяжело не только из-за защиты — поговорите с кем-то близким или с психологической службой вуза. ' +
  'Когда будете готовы, можно продолжить с того же вопроса.';

// Проверка питча до вызова модели. Возвращает null, если всё ок, или объяснение отказа.
function checkPitch(pitch) {
  const { pitchMin } = config.limits;
  if (!pitch) {
    return { code: 'empty', message: 'Питч пустой. Инвестору нечего разносить.', checklist: PITCH_CHECKLIST };
  }
  if (letterRatio(pitch) < 0.5) {
    return { code: 'garbage', message: 'Это не похоже на описание проекта. Напишите словами, что вы делаете.', checklist: PITCH_CHECKLIST };
  }
  if (pitch.length < pitchMin || wordCount(pitch) < 20) {
    return {
      code: 'too_short',
      message: `Слишком коротко: на сцене у вас 3 минуты, а здесь меньше ${pitchMin} символов. Добавьте хотя бы эти пункты:`,
      checklist: PITCH_CHECKLIST,
    };
  }
  return null;
}

// Проверка цитаты-доказательства: модель обязана цитировать текст студента дословно.
// Если цитаты нет в источнике, балл режется кодом — так бот не может «выдумать» факт.
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'“”„`….,:;!?()[\]{}\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function evidenceFound(quote, source) {
  const q = norm(quote);
  if (q.length < 4) return false;
  const src = norm(source);
  if (src.includes(q)) return true;
  // Допускаем мелкие расхождения: 80% значимых слов цитаты есть в источнике.
  const words = q.split(' ').filter((w) => w.length >= 4);
  if (words.length < 3) return false;
  const hits = words.filter((w) => src.includes(w)).length;
  return hits / words.length >= 0.8;
}

const GENERIC_ADVICE = [
  /проведите\s+(исследование|анализ)\s+рынка/i,
  /изучите\s+(рынок|конкурентов|целевую)/i,
  /улучшите\s+(презентацию|питч|продукт)/i,
  /поработайте\s+над/i,
  /подумайте\s+(о|над)/i,
  /больше\s+(уверенности|практики)/i,
];

// Совет должен быть действием за дни, а не за месяцы. Возвращает список проблем.
function adviceProblems(list, targetIds) {
  const problems = [];
  if (!Array.isArray(list) || list.length !== 3) return ['нужно ровно 3 совета'];
  const ids = new Set();
  list.forEach((a, i) => {
    const n = i + 1;
    if (!a || typeof a.action !== 'string') return problems.push(`совет ${n}: нет действия`);
    if (wordCount(a.action) < 6) problems.push(`совет ${n}: слишком общий, нужен конкретный шаг`);
    if (GENERIC_ADVICE.some((re) => re.test(a.action))) problems.push(`совет ${n}: это пожелание, а не действие`);
    if (/месяц|недел/i.test(a.time || '')) problems.push(`совет ${n}: дольше двух дней`);
    if (!a.stage_line) problems.push(`совет ${n}: нет фразы для сцены`);
    ids.add(a.criterion_id);
  });
  if (targetIds && targetIds.some((id) => !ids.has(id))) problems.push('советы должны закрывать три выбранных критерия');
  return problems;
}

module.exports = {
  clean,
  checkPitch,
  detectManipulation,
  detectDistress,
  evidenceFound,
  adviceProblems,
  PITCH_CHECKLIST,
  SUPPORT_MESSAGE,
  wordCount,
};
