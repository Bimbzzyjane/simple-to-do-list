'use strict';

/**
 * test/api.test.js
 * ---------------------------------------------------------------------------
 * Checks the REST API against a throwaway database, so your real data is never
 * touched. Run it with:  npm test
 *
 * We start the real server on a random free port (port 0) and talk to it with
 * fetch() - the same way the browser does.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the database at a temporary file BEFORE requiring the app.
const TEST_DB = path.join(os.tmpdir(), `todo-test-${process.pid}.db`);
process.env.DB_FILE = TEST_DB;

const app = require('../server');
const db = require('../db');

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) console.log(`        got:      ${JSON.stringify(actual)}\n        expected: ${JSON.stringify(expected)}`);
}

/** Call the API and give back { status, body }. */
async function call(base, method, url, body) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }

  const response = await fetch(base + url, options);
  const text = await response.text();

  // Some routes (like GET /) return the HTML page, so only parse when we can.
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { notJson: true };
  }

  return { status: response.status, body: parsed };
}

async function run() {
  const server = app.listen(0); // 0 = "any free port"
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('\nAPI TESTS');

  console.log('\n1) Creating tasks');
  let result = await call(base, 'GET', '/api/todos');
  check('new database starts empty', result.body, []);

  result = await call(base, 'POST', '/api/todos', {
    title: 'Buy milk',
    note: 'Semi-skimmed, 2 bottles',
    due: '2026-10-01',
  });
  const milk = result.body;
  check('POST returns 201', result.status, 201);
  check('title is stored', milk.title, 'Buy milk');
  check('note is stored', milk.note, 'Semi-skimmed, 2 bottles');
  check('due date is stored', milk.due, '2026-10-01');
  check('new task is not completed', milk.completed, false);

  const walk = (await call(base, 'POST', '/api/todos', { title: 'Walk the dog' })).body;
  const app2 = (await call(base, 'POST', '/api/todos', { title: 'Write tests' })).body;
  check('note defaults to empty string', walk.note, '');
  check('due defaults to null', walk.due, null);

  console.log('\n2) Bad input is rejected');
  check('empty title -> 400', (await call(base, 'POST', '/api/todos', { title: '  ' })).status, 400);
  check('missing title -> 400', (await call(base, 'POST', '/api/todos', {})).status, 400);
  check('bad due date -> 400', (await call(base, 'POST', '/api/todos', { title: 'x', due: '01/10/2026' })).status, 400);
  check('impossible date -> 400', (await call(base, 'POST', '/api/todos', { title: 'x', due: '2026-13-45' })).status, 400);
  check('note too long -> 400', (await call(base, 'POST', '/api/todos', { title: 'x', note: 'a'.repeat(1001) })).status, 400);
  check('empty body -> 400', (await call(base, 'PATCH', `/api/todos/${milk.id}`, {})).status, 400);
  check('bad completed type -> 400', (await call(base, 'PATCH', `/api/todos/${milk.id}`, { completed: 'yes' })).status, 400);
  check('non-numeric id -> 400', (await call(base, 'PATCH', '/api/todos/abc', { completed: true })).status, 400);
  check('unknown id -> 404', (await call(base, 'PATCH', '/api/todos/9999', { completed: true })).status, 404);

  console.log('\n3) Updating tasks');
  result = await call(base, 'PATCH', `/api/todos/${milk.id}`, { note: 'Whole milk instead' });
  check('note can be edited', result.body.note, 'Whole milk instead');

  result = await call(base, 'PATCH', `/api/todos/${milk.id}`, { due: null });
  check('due date can be removed', result.body.due, null);

  await call(base, 'PATCH', `/api/todos/${walk.id}`, { completed: true });
  result = await call(base, 'PATCH', `/api/todos/${milk.id}`, { title: 'Buy oat milk', completed: true });
  check('title and completed can change together', [result.body.title, result.body.completed], ['Buy oat milk', true]);
  check('note survives an unrelated update', result.body.note, 'Whole milk instead');

  console.log('\n4) Reordering');
  result = await call(base, 'GET', '/api/todos');
  check('new tasks go on the end', result.body.map((t) => t.id), [milk.id, walk.id, app2.id]);

  result = await call(base, 'PUT', '/api/todos/order', { ids: [app2.id, milk.id, walk.id] });
  check('PUT order returns 200', result.status, 200);
  check('new order is returned', result.body.map((t) => t.id), [app2.id, milk.id, walk.id]);

  result = await call(base, 'GET', '/api/todos');
  check('new order is remembered', result.body.map((t) => t.id), [app2.id, milk.id, walk.id]);

  result = await call(base, 'GET', '/api/todos');
  check('notes come back in the list', result.body[0].note, '');

  check('order with too few ids -> 400', (await call(base, 'PUT', '/api/todos/order', { ids: [milk.id] })).status, 400);
  check('order with duplicates -> 400', (await call(base, 'PUT', '/api/todos/order', { ids: [milk.id, milk.id, walk.id] })).status, 400);
  check('order with unknown id -> 400', (await call(base, 'PUT', '/api/todos/order', { ids: [9001, 9002, 9003] })).status, 400);
  check('order must be an array -> 400', (await call(base, 'PUT', '/api/todos/order', { ids: 'nope' })).status, 400);

  console.log('\n5) Deleting');
  result = await call(base, 'DELETE', '/api/todos/completed');
  check('clear completed returns how many went', result.body.deleted, 2);
  check('only the unfinished task is left', result.body.todos.map((t) => t.id), [app2.id]);

  check('delete one -> 204', (await call(base, 'DELETE', `/api/todos/${app2.id}`)).status, 204);
  check('deleting it twice -> 404', (await call(base, 'DELETE', `/api/todos/${app2.id}`)).status, 404);
  check('list is empty again', (await call(base, 'GET', '/api/todos')).body, []);

  console.log('\n6) Frontend files and errors');
  check('GET / serves the page', (await call(base, 'GET', '/')).status, 200);
  check('unknown API route -> 404', (await call(base, 'GET', '/api/nope')).status, 404);
  check('unknown API route is JSON', (await call(base, 'GET', '/api/nope')).body.error !== undefined, true);

  // ---- clean up -----------------------------------------------------------
  server.close();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(TEST_DB + suffix, { force: true });
  }

  console.log(`\n${failed === 0 ? 'ALL API TESTS PASSED' : failed + ' API TEST(S) FAILED'} (${passed} passed)\n`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((error) => {
  console.error('\nThe API test run crashed:', error);
  process.exit(1);
});
