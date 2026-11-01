// Tests for the MCP server at /mcp, on a server with a directory library.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { projectRoot, startLibraryServer, startServer } from './helpers.mjs';

const skip = process.env.TEST_URL ? 'needs its own server with a library' : false;

async function post(base, body, headers = {}) {
  const res = await fetch(new URL('mcp', base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

describe('MCP server', { skip }, () => {
  let server;
  let mage;
  let firstVersion;
  let id = 0;
  const rpc = async (method, params) => (await post(server.url, { jsonrpc: '2.0', id: ++id, method, params })).body;
  const callTool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  const textOf = (result) => result.content.map((c) => c.text).join('\n');

  before(async () => {
    server = await startLibraryServer();
    mage = JSON.parse(await readFile(path.join(projectRoot, 'tests/fixtures/artillery-mage.json'), 'utf8')).characters[0];
    const save = async (character, baseVersion) =>
      (
        await fetch(new URL('api/characters/c-mage', server.url), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ character, baseVersion }),
        })
      ).json();
    firstVersion = (await save({ ...mage, attrs: { ...mage.attrs, character_name: 'Apprentice Mage' } })).version;
    await save(mage, firstVersion);
  });

  after(() => server?.stop());

  test('negotiates the protocol version and describes itself', async () => {
    const { version } = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    const init = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result;
    assert.equal(init.protocolVersion, '2025-06-18');
    assert.deepEqual(init.serverInfo, { name: 'gurps-sheet', title: 'GURPS character sheets', version });
    assert.ok(init.capabilities.tools);
    assert.match(init.instructions, /repeating_<section>_<rowId>_<field>/);
    assert.equal((await rpc('initialize', { protocolVersion: '2099-01-01' })).result.protocolVersion, '2025-11-25', 'its newest for an unknown version');

    const notification = await post(server.url, { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(notification.status, 202);
    assert.equal(notification.body, null);
    assert.deepEqual((await rpc('ping')).result, {});
  });

  test('lists its tools', async () => {
    const { tools } = (await rpc('tools/list')).result;
    assert.deepEqual(tools.map((t) => t.name), ['list_characters', 'get_character', 'get_character_history', 'get_character_version', 'sheet_fields']);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.annotations.readOnlyHint, true);
    }
  });

  test('lists and summarizes characters, with the values the sheet computes', async () => {
    assert.match(textOf(await callTool('list_characters')), /^- Artillery Mage \(c-mage\), saved \d{4}-\d\d-\d\d \d\d:\d\d UTC$/m);

    const summary = textOf(await callTool('get_character', { character: 'artillery' }));
    assert.match(summary, /^Character c-mage, version artillery-mage--.*\.json/);
    for (const line of [
      '# Artillery Mage',
      'Points: 150 total, 173 spent, -23 unspent', // auto-calc fields
      'ST 9 · DX 10 · IQ 13 · HT 10',
      '- Magery 3 [30]',
      '- Staff (DX/A) 11 [4]', // select labels
      '- Stone Missile (H) 12 [2] — Earth/Missile, cost 1 to Magery, time 1 to 3 sec., duration Instant',
      '- Quarterstaff (Staff Swing): 1d6+1 cr, reach 1,2, skill 11',
      '- Fireball: [# of Die] burn, Acc 1, range 25/50, skill 13',
      '- Quarterstaff (Staff Swing): Parry 10', // a computed row field
      '- Quarterstaff, 4.000 lbs, $40.00',
    ]) {
      assert.ok(summary.includes(line), `has "${line}"`);
    }

    const raw = JSON.parse(textOf(await callTool('get_character', { character: 'c-mage', detail: 'attributes' })));
    assert.equal(raw.attrs.strength_points, mage.attrs.strength_points);
    assert.deepEqual(raw.sections, mage.sections);
  });

  test('lists deleted characters apart, and keeps their history', async () => {
    const save = await fetch(new URL('api/characters/c-gone', server.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ character: { attrs: { character_name: 'Gone Guy' } } }),
    });
    const { version } = await save.json();
    await fetch(new URL('api/characters/c-gone', server.url), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: version }),
    });
    const list = textOf(await callTool('list_characters'));
    assert.match(list, /^- Artillery Mage \(c-mage\)/);
    assert.match(list, /\n\nDeleted \(get_character_history still has their versions\):\n- Gone Guy \(c-gone\), deleted /);
    assert.match(textOf(await callTool('get_character', { character: 'c-gone' })), /c-gone was deleted/);
    assert.match(textOf(await callTool('get_character_history', { character: 'c-gone' })), /^2 versions of c-gone/);
  });

  test('gives the history and older versions', async () => {
    const history = textOf(await callTool('get_character_history', { character: 'Artillery Mage' }));
    assert.match(history, /^2 versions of c-mage/);
    assert.ok(history.indexOf('"Artillery Mage"') < history.indexOf('"Apprentice Mage"'), 'newest first');
    assert.match(textOf(await callTool('get_character_version', { character: 'c-mage', version: firstVersion })), /# Apprentice Mage/);
  });

  test('lists the sheet’s fields', async () => {
    const sections = textOf(await callTool('sheet_fields'));
    assert.match(sections, /^- character: \d+$/m);
    assert.match(sections, /^- repeating_skills: \d+$/m);
    const skills = textOf(await callTool('sheet_fields', { section: 'repeating_skills' }));
    assert.match(skills, /^- difficulty \(select; choices: -1 \(E\), -2 \(A\), -3 \(H\), -4 \(VH\)/m);
    assert.match(skills, /^- level \(.*set by the sheet\)$/m);
    const found = textOf(await callTool('sheet_fields', { search: 'point_summary' }));
    assert.match(found, /^- character: point_summary \(text; computed: @\{attribute_positive_total\} \+ /);
  });

  test('reports mistakes as tool errors', async () => {
    const error = async (name, args) => {
      const result = await callTool(name, args);
      assert.equal(result.isError, true);
      return textOf(result);
    };
    assert.match(await error('get_character', { character: 'Nobody' }), /No character called "Nobody"/);
    assert.match(await error('get_character', {}), /"character" is required/);
    assert.match(await error('get_character', { character: 'mage', detail: 'everything' }), /one of summary, attributes/);
    assert.match(await error('get_character', { character: 'mage', colour: 'red' }), /Unknown argument "colour"/);
    assert.match(await error('get_character_version', { character: 'mage', version: 'nope' }), /no version "nope"/);
    assert.match(await error('sheet_fields', { search: 'no-such-field' }), /No fields matching/);
  });

  test('answers JSON-RPC and transport errors', async () => {
    assert.equal((await rpc('tools/call', { name: 'roll_dice', arguments: {} })).error.code, -32602);
    assert.equal((await rpc('resources/list')).error.code, -32601);

    const parse = await post(server.url, '{oops');
    assert.equal(parse.status, 400);
    assert.equal(parse.body.error.code, -32700);
    assert.equal((await post(server.url, [])).status, 400);
    assert.equal((await post(server.url, { id: 1, method: 'ping' })).body.error.code, -32600);

    const batch = await post(server.url, [
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'b', method: 'ping' },
    ]);
    assert.deepEqual(batch.body.map((r) => r.id), ['a', 'b']);

    const get = await fetch(new URL('mcp', server.url));
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    assert.equal((await post(server.url, ping, { Origin: 'https://evil.example' })).status, 403);
    // A page whose origin names the same host as the request, as after DNS rebinding.
    assert.equal((await post(server.url, ping, { Origin: new URL(server.url).origin })).status, 403);
    assert.equal((await post(server.url, ping, { 'MCP-Protocol-Version': '1999-01-01' })).status, 400);
    assert.equal((await post(server.url, ping, { 'MCP-Protocol-Version': '2025-06-18' })).status, 200);
  });
});

describe('MCP server without a library', { skip }, () => {
  test('is off', async () => {
    const server = await startServer();
    try {
      const res = await post(server.url, { jsonrpc: '2.0', id: 1, method: 'ping' });
      assert.equal(res.status, 404);
    } finally {
      server.stop();
    }
  });
});
