'use strict';

const config = require('./config');
const mock = require('./mock');

class LLMError extends Error {}

function extractJson(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) throw new LLMError('В ответе модели нет JSON');
  return JSON.parse(s.slice(start, end + 1));
}

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.llmTimeoutMs),
  });
  if (!res.ok) {
    // Тело ответа провайдера не пробрасываем пользователю: там могут быть служебные детали.
    const err = new LLMError(`LLM HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function callAnthropic({ system, user, schema, name, maxTokens }) {
  const c = config.anthropic;
  const data = await postJson(
    `${c.baseUrl}/v1/messages`,
    { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' },
    {
      model: c.model,
      max_tokens: maxTokens,
      temperature: 0.4,
      system,
      messages: [{ role: 'user', content: user }],
      tools: [{ name, description: 'Верни результат строго по схеме', input_schema: schema }],
      tool_choice: { type: 'tool', name },
    },
  );
  const block = (data.content || []).find((b) => b.type === 'tool_use');
  if (!block || typeof block.input !== 'object') throw new LLMError('Модель не вернула структуру');
  return block.input;
}

async function callOpenAI({ system, user, schema, maxTokens }) {
  const c = config.openai;
  const data = await postJson(
    `${c.baseUrl}/chat/completions`,
    { authorization: `Bearer ${c.apiKey}` },
    {
      model: c.model,
      max_tokens: maxTokens,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        {
          role: 'user',
          content: `${user}\n\nВерни ТОЛЬКО JSON-объект по этой JSON-схеме:\n${JSON.stringify(schema)}`,
        },
      ],
    },
  );
  return extractJson(data.choices?.[0]?.message?.content);
}

const RETRYABLE = (e) => !e.status || e.status === 429 || e.status >= 500;

// Единая точка вызова модели: структурированный ответ, таймаут, одна повторная попытка.
async function callJSON(opts) {
  const params = { maxTokens: 1500, ...opts };
  if (config.provider === 'mock') {
    const delay = Number(process.env.MOCK_DELAY_MS) || 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return mock.respond(params);
  }
  const fn = config.provider === 'anthropic' ? callAnthropic : callOpenAI;
  try {
    return await fn(params);
  } catch (e) {
    if (!RETRYABLE(e)) throw e;
    await new Promise((r) => setTimeout(r, 800));
    return fn(params);
  }
}

module.exports = { callJSON, LLMError, extractJson };
