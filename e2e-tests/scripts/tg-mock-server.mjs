#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import TelegramServer from '/root/.openclaw/workspace/tmp/telegram-test-api-review/telegram-test-api/lib/index.js';

const host = process.env.TG_MOCK_HOST || '127.0.0.1';
const port = Number(process.env.TG_MOCK_PORT || '19001');
const stateDir = process.env.TG_MOCK_STATE_DIR || '/work/e2e-openclaw/state/tg-mock';
const logPrefix = 'tg-mock';
const ts = () => new Date().toISOString();

fs.mkdirSync(stateDir, { recursive: true });

const server = new TelegramServer({ host, port, protocol: 'http', storage: 'RAM', storeTimeout: 3600 });
const webServer = server.webServer || server._webServer || server.app;
if (webServer && typeof webServer.use === 'function') {
  webServer.use((req, res, next) => {
    const raw = typeof req.body === 'undefined' ? undefined : req.body;
    console.log(`${ts()} ${logPrefix}: HTTP ${req.method} ${req.originalUrl || req.url} body=${JSON.stringify(raw ?? null)}`);
    res.on('finish', () => {
      console.log(`${ts()} ${logPrefix}: HTTP ${req.method} ${req.originalUrl || req.url} status=${res.statusCode}`);
    });
    next();
  });
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(stateDir, name), JSON.stringify(value, null, 2));
}

server.on('AddedUserMessage', () => {
  const token = process.env.TG_MOCK_TOKEN || 'TEST:TOKEN';
  const history = server.getUpdatesHistory(token);
  writeJson('history.latest.json', history);
  const last = history.at(-1);
  const text = last && 'message' in last ? last.message?.text : undefined;
  console.log(`${ts()} ${logPrefix}: AddedUserMessage text=${JSON.stringify(text ?? null)}`);
});
server.on('AddedBotMessage', () => {
  const token = process.env.TG_MOCK_TOKEN || 'TEST:TOKEN';
  const history = server.getUpdatesHistory(token);
  writeJson('history.latest.json', history);
  const last = history.at(-1);
  const text = last && 'message' in last ? last.message?.text : undefined;
  const chatId = last && 'message' in last ? last.message?.chat_id : undefined;
  console.log(`${ts()} ${logPrefix}: AddedBotMessage chat_id=${JSON.stringify(chatId ?? null)} text=${JSON.stringify(text ?? null)}`);
});
server.on('EditedMessageText', () => console.log(`${ts()} ${logPrefix}: EditedMessageText`));
server.on('EditedMessageReplyMarkup', () => console.log(`${ts()} ${logPrefix}: EditedMessageReplyMarkup`));

await server.start();
writeJson('server-info.json', { host, port, apiURL: server.config.apiURL, startedAt: new Date().toISOString() });
console.log(`${ts()} ${logPrefix}: listening apiURL=${server.config.apiURL}`);

const shutdown = async (signal) => {
  console.log(`${ts()} ${logPrefix}: shutting down signal=${signal}`);
  try {
    writeJson('history.latest.json', server.getUpdatesHistory(process.env.TG_MOCK_TOKEN || 'TEST:TOKEN'));
  } catch {}
  await server.stop();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
