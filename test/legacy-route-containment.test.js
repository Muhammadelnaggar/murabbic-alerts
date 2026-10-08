const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { test } = require('node:test');
const express = require('express');

const serverPath = path.resolve(__dirname, '../server.js');
const serverRequire = createRequire(serverPath);

// Execute the actual server registrations, without Firebase, maintenance timers,
// filesystem writes, or a production listener. No credentials enter this VM.
function loadApp() {
  let app;
  const sandbox = {
    __dirname: path.dirname(serverPath),
    process: { env: {} },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0,
    setInterval: () => 0,
    clearTimeout() {},
    Buffer,
    URL,
    AbortController,
    fetch: () => { throw new Error('External network forbidden in containment tests'); },
    require(name) {
      if (name.startsWith('/etc/secrets/')) throw new Error('Credentials forbidden in tests');
      if (name === 'firebase-admin') return { apps: [] };
      if (name === 'fs') return {
        existsSync: fs.existsSync,
        readFileSync: fs.readFileSync,
        mkdirSync() { throw new Error('Filesystem writes forbidden in tests'); },
        writeFileSync() { throw new Error('Filesystem writes forbidden in tests'); }
      };
      if (name === 'express') {
        const factory = () => {
          app = express();
          app.listen = () => {}; // Suppress server.js startup listener.
          return app;
        };
        return Object.assign(factory, express);
      }
      return serverRequire(name);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(serverPath, 'utf8'), sandbox, { filename: serverPath });

  const records = {
    animals: [
      { id: 'animal-A', userId: 'tenant-A', number: '42' },
      { id: 'animal-B', userId: 'tenant-B', number: '42', privateData: 'B-private-animal' }
    ],
    events: [{ id: 'event-B', userId: 'tenant-B', animalNumber: '42', privateData: 'B-private-event' }]
  };
  const before = JSON.stringify(records);
  const accesses = [];
  const fixtureDb = {
    collection(name) {
      accesses.push(name);
      const allRows = records[name] || [];
      function query(rows) {
        return {
          where(field, _operator, value) { return query(rows.filter(row => row[field] === value)); },
          limit(n) { return query(rows.slice(0, n)); },
          async get() { return { docs: rows.map(snapshot), empty: !rows.length }; },
          doc(id) { return { get: async () => snapshot(allRows.find(row => row.id === id)) }; }
        };
      }
      function snapshot(row) {
        return {
          exists: !!row,
          id: row?.id,
          data: () => row,
          ref: { path: `${name}/${row?.id}`, set: async patch => Object.assign(row, patch) }
        };
      }
      return query(allRows);
    }
  };
  sandbox.fixtureDb = fixtureDb;
  sandbox.authenticationCalls = 0;
  // Downstream auth is a test fixture: authenticated A/B/admin are authorized
  // to use normal API routes. It must never be reached for disabled routes.
  vm.runInContext(`
    db = fixtureDb;
    requireUserId = (req, res, next) => {
      authenticationCalls++;
      const actor = req.headers['x-test-actor'];
      if (!actor || actor === 'expired') return res.sendStatus(401);
      req.userId = actor === 'tenant-B' ? 'tenant-B' : 'tenant-A';
      req.authSession = { uid: actor, userId: req.userId };
      next();
    };
    requireSubscriptionAccessSrv = (_req, _res, next) => next();
  `, sandbox);
  return { app, sandbox, records, before, accesses };
}

test('legacy routes reject every caller before authorization or database access', async t => {
  const fixture = loadApp();
  const server = express.application.listen.call(fixture.app, 0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const actor of [null, 'expired', 'tenant-A', 'tenant-B', 'admin']) {
    await t.test(`caller ${actor || 'anonymous'} cannot dump or claim shared number 42`, async () => {
      for (const [method, route] of [
        ['GET', '/api/debug/animals/all'],
        ['GET', '/api/debug/events/all'],
        ['POST', '/api/fix/animals/claim?nums=42&allow=tenant-B'],
        ['POST', '/api/fix/animals/claim?nums=42&allow=tenant-B&dry=1']
      ]) {
        const response = await fetch(base + route, {
          method,
          headers: actor ? { 'x-test-actor': actor } : {}
        });
        assert.equal(response.status, 404, `${actor}: ${route}`);
        assert.equal(await response.text(), 'Not Found');
      }
      assert.equal(JSON.stringify(fixture.records), fixture.before);
      assert.deepEqual(fixture.accesses, []);
      assert.equal(fixture.sandbox.authenticationCalls, 0);
    });
  }

  await t.test('method, case, trailing slash and malformed body cannot bypass containment', async () => {
    for (const route of ['/api/debug/animals/all', '/api/debug/events/all', '/api/fix/animals/claim']) {
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
        const response = await fetch(base + route.toUpperCase() + '/?nums=42&allow=tenant-B', {
          method,
          headers: { 'Content-Type': 'application/json', 'x-test-actor': 'admin' },
          ...(!['GET', 'HEAD'].includes(method) ? { body: '{invalid json' } : {})
        });
        assert.equal(response.status, 404);
        assert.equal(await response.text(), method === 'HEAD' ? '' : 'Not Found');
      }
    }
    assert.deepEqual(fixture.accesses, []);
    assert.equal(fixture.sandbox.authenticationCalls, 0);
    assert.equal(JSON.stringify(fixture.records), fixture.before);
  });

  await t.test('official routes still reach their existing authorization gate', async () => {
    for (const route of ['/api/animals', '/api/events', '/api/smart-alerts']) {
      const response = await fetch(base + route);
      assert.equal(response.status, 401);
    }
    assert.equal(fixture.sandbox.authenticationCalls, 3);
    assert.deepEqual(fixture.accesses, []);
  });
});
