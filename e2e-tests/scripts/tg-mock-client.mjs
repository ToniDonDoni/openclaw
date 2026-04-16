#!/usr/bin/env node
import process from 'node:process';

const api = process.env.TG_MOCK_API || 'http://127.0.0.1:19001';
const token = process.env.TG_MOCK_TOKEN || 'TEST:TOKEN';
const chatId = Number(process.env.TG_MOCK_CHAT_ID || '900000001');
const userId = Number(process.env.TG_MOCK_USER_ID || '900000001');
const firstName = process.env.TG_MOCK_FIRST_NAME || 'Test';
const username = process.env.TG_MOCK_USERNAME || 'test_name';
const text = process.argv.slice(2).join(' ') || '/ping';

const body = {
  botToken: token,
  date: Math.floor(Date.now() / 1000),
  text,
  from: {
    id: userId,
    first_name: firstName,
    username,
    is_bot: false,
    language_code: 'en',
    is_premium: true,
  },
  chat: {
    id: chatId,
    first_name: firstName,
    username,
    type: 'private',
  },
};

const res = await fetch(`${api}/sendMessage`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const data = await res.json();
console.log(JSON.stringify({ ok: res.ok, status: res.status, request: body, response: data }, null, 2));
