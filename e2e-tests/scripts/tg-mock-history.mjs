#!/usr/bin/env node
import process from 'node:process';

const api = process.env.TG_MOCK_API || 'http://127.0.0.1:19001';
const token = process.env.TG_MOCK_TOKEN || 'TEST:TOKEN';

const res = await fetch(`${api}/getUpdatesHistory`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token }),
});
const data = await res.json();
console.log(JSON.stringify(data, null, 2));
