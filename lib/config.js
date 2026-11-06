'use strict';

const fs = require('fs');
const path = require('path');

// Мини-загрузчик .env для локального запуска (без зависимостей). На хостинге переменные задаются в панели.
function loadDotEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^['"]|['"]$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv();

const env = process.env;

function detectProvider() {
  const wanted = (env.LLM_PROVIDER || '').toLowerCase();
  if (wanted === 'mock') return 'mock';
  if (wanted === 'anthropic' && env.ANTHROPIC_API_KEY) return 'anthropic';
  if (wanted === 'openai' && env.OPENAI_API_KEY) return 'openai';
  if (!wanted) {
    if (env.ANTHROPIC_API_KEY) return 'anthropic';
    if (env.OPENAI_API_KEY) return 'openai';
  }
  return 'mock';
}

const provider = detectProvider();

const config = {
  port: Number(env.PORT) || 3000,
  investor: env.INVESTOR || 'angel',
  provider,
  anthropic: {
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    baseUrl: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
  },
  openai: {
    apiKey: env.OPENAI_API_KEY || '',
    model: env.OPENAI_MODEL || 'gpt-4o-mini',
    baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  },
  llmTimeoutMs: Number(env.LLM_TIMEOUT_MS) || 45000,
  limits: {
    pitchMin: 150,
    pitchMax: 6000,
    answerMax: 1500,
    sessionTtlMs: 60 * 60 * 1000,
    maxSessions: 2000,
  },
  trustProxy: env.TRUST_PROXY !== 'false',
};

module.exports = config;
