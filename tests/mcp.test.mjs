// Tests for the MCP server at /mcp, on a server with a directory library.
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { mcpTokensFromEnv } from '../lib/mcp.mjs';
import { projectRoot, startLibraryServer, startServer } from './helpers.mjs';

const skip = process.env.TEST_URL ? 'needs its own server with a library' : false;

async function post(base, body, headers = {}, endpoint = 'mcp') {
  const res = await fetch(new URL(endpoint, base), {
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
    const writers = ['create_character', 'edit_character', 'import_character'];
    assert.deepEqual(tools.map((t) => t.name), ['list_characters', 'get_character', 'get_character_history', 'get_character_version', 'sheet_fields', 'roll_command', ...writers]);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.annotations.readOnlyHint, !writers.includes(tool.name));
      assert.equal(tool.annotations.destructiveHint, false, 'edits add versions; nothing is lost');
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

  test('gives Roll20 commands', async () => {
    const staff = textOf(await callTool('roll_command', { character: 'mage', roll: 'Staff', modifier: -2 }));
    assert.equal(staff, 'Staff (skill)\n/roll {3d6[Staff],0d0+99}<9   (succeeds on 9 or less)\nPrompt "Modifier": -2');
    const fireball = textOf(await callTool('roll_command', { character: 'mage', roll: 'Fireball', damage: true, answers: { '# of Die': '2d6+2' } }));
    assert.match(fireball, /^\/roll \{ 2d6\[Fireball\]\+2, \{1\} \}kh1$/m);
    assert.match(fireball, /^Prompt "# of Die": 2d6\+2 \(choices: 1d6\+1, 2d6\+2, /m);
    assert.match(textOf(await callTool('roll_command', { character: 'mage', roll: 'Quarterstaff (Staff Swing)' })), /is also a defense: pass kind/);
    const unknown = await callTool('roll_command', { character: 'mage', roll: 'Juggling' });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /No roll called "Juggling"/);
  });

  test('creates, edits and imports characters with the sheet', async () => {
    const created = textOf(
      await callTool('create_character', {
        name: 'Sir Testalot',
        changes: [
          { action: 'set', values: { strength_points: 20 } },
          { action: 'add_row', section: 'skills', values: { name: 'Broadsword', base: 'DX', difficulty: 'A', points: 4 } },
        ],
      }),
    );
    const id = /^Created "Sir Testalot" \((c-[a-z0-9-]+)\), version /.exec(created)?.[1];
    assert.ok(id, created);
    assert.ok(created.includes('ST 12 · DX 10'));
    assert.ok(created.includes('- Broadsword (DX/A) 11 [4]'));

    const edited = textOf(
      await callTool('edit_character', {
        character: id,
        changes: [{ action: 'update_row', section: 'skills', row: 'broadsword', values: { points: 8 } }],
      }),
    );
    assert.match(edited, /^Saved "Sir Testalot" as version .*\nChanges:\n- changed repeating_skills row -\S+ \(Broadsword\): points = "8"/);
    assert.ok(edited.includes('- Broadsword (DX/A) 12 [8]'));
    assert.match(textOf(await callTool('get_character_history', { character: id })), /^2 versions/);
    const stored = (await (await fetch(new URL(`api/characters/${id}`, server.url))).json()).character;
    assert.equal(stored.name, 'Sir Testalot');

    const rampage = await readFile(path.join(projectRoot, 'GURPS/readme/assets/Rampage (NPC) export.json'), 'utf8');
    const imported = textOf(await callTool('import_character', { content: rampage }));
    assert.match(imported, /^Imported "Rampage" \(c-[a-z0-9-]+\), version /);
    assert.ok(imported.includes('ST 17 · DX 12 · IQ 10 · HT 12'));
    assert.ok(textOf(await callTool('list_characters')).includes('- Rampage ('));
  });

  test('refuses edits the sheet wouldn’t take', async () => {
    const error = async (name, args) => {
      const result = await callTool(name, args);
      assert.equal(result.isError, true, JSON.stringify(result));
      return textOf(result);
    };
    const before = textOf(await callTool('get_character_history', { character: 'mage' }));
    assert.match(await error('edit_character', { character: 'mage', changes: [{ action: 'set', values: { dodge: 12 } }] }), /"dodge" is computed by the sheet/);
    assert.match(await error('edit_character', { character: 'mage', changes: [] }), /"changes" is empty/);
    assert.match(await error('edit_character', { character: 'mage', changes: 'more ST' }), /"changes" must be a list/);
    assert.equal(textOf(await callTool('get_character_history', { character: 'mage' })), before, 'nothing saved');
    assert.match(await error('import_character', { content: 'not json' }), /isn’t JSON/);
    assert.match(await error('import_character', { content: '{"hello": "world"}' }), /The sheet’s importer said: /);
    assert.match(await error('roll_command', { character: 'mage', roll: 'Staff', modifier: '-2' }), /"modifier" must be a whole number/);
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
    assert.equal((await post(server.url, ping, {}, 'mcp/some-token-0123456789')).status, 404, 'no token is set');
  });
});

describe('MCP server with tokens', { skip }, () => {
  const first = 'first-token_0123456789';
  const second = 'second-token-0123456789';
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  let server;

  before(async () => {
    server = await startLibraryServer({ env: { MCP_TOKEN: ` ${first}, ${second} ` } });
  });

  after(() => server?.stop());

  test('lets in only clients with a token', async () => {
    const none = await post(server.url, ping);
    assert.equal(none.status, 401);
    assert.equal(none.headers.get('www-authenticate'), 'Bearer realm="gurps-sheet"');
    assert.match(none.body.error, /needs its token/);
    assert.equal((await post(server.url, ping, { Authorization: 'Bearer wrong-token-0123456789' })).status, 401);
    assert.equal((await post(server.url, ping, {}, 'mcp/wrong-token-0123456789')).status, 401);
    assert.equal((await post(server.url, ping, {}, `mcp/${first}/more`)).status, 401);
  });

  test('takes any of its tokens, in the header or the URL', async () => {
    assert.deepEqual((await post(server.url, ping, { Authorization: `Bearer ${first}` })).body.result, {});
    assert.deepEqual((await post(server.url, ping, { Authorization: `bearer ${second}` })).body.result, {});
    assert.deepEqual((await post(server.url, ping, {}, `mcp/${second}`)).body.result, {});
    assert.deepEqual((await post(server.url, ping, {}, `mcp%2F${first}`)).body.result, {}, 'the path is decoded first');
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_characters', arguments: {} } };
    assert.match((await post(server.url, call, {}, `mcp/${first}`)).body.result.content[0].text, /no characters/);
  });

  test('still refuses web pages', async () => {
    assert.equal((await post(server.url, ping, { Origin: 'https://evil.example' }, `mcp/${first}`)).status, 403);
  });
});

describe('MCP_TOKEN', () => {
  test('lists the tokens, and refuses short or URL-unsafe ones', () => {
    assert.deepEqual(mcpTokensFromEnv({}), []);
    assert.deepEqual(mcpTokensFromEnv({ MCP_TOKEN: ' ' }), []);
    assert.throws(() => mcpTokensFromEnv({ MCP_TOKEN: ' , ' }), /no token/, 'not open by mistake');
    assert.deepEqual(mcpTokensFromEnv({ MCP_TOKEN: 'abcdefghijklmnop, ,qrstuvwxyz-_0123' }), ['abcdefghijklmnop', 'qrstuvwxyz-_0123']);
    assert.throws(() => mcpTokensFromEnv({ MCP_TOKEN: 'short' }), /at least 16/);
    assert.throws(() => mcpTokensFromEnv({ MCP_TOKEN: 'has/a/slash/0123456789' }), /at least 16/);
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

describe('MCP server with rulebooks', { skip }, () => {
  const token = 'rules-token-0123456789';
  let dir;
  let servers = [];
  let id = 0;
  const rpc = async (server, method, params) =>
    (await post(server.url, { jsonrpc: '2.0', id: ++id, method, params }, {}, `mcp/${token}`)).body;
  const tool = async (server, name, args) => (await rpc(server, 'tools/call', { name, arguments: args })).result;
  const toolNames = async (server) => (await rpc(server, 'tools/list')).result.tools.map((t) => t.name);
  // The rules load in the background; their tools say so until then.
  async function ready(server) {
    for (let i = 0; /still loading/.test((await tool(server, 'read_rules', { ref: 'T1' })).content[0].text); i++) {
      if (i > 50) throw new Error('The rules never loaded');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return server;
  }
  const start = async (starter, env) => {
    const server = await starter({ env: { RULES_DIR: dir, ...env } });
    servers.push(server);
    return server;
  };

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'gurps-rules-'));
    await copyFile(path.join(projectRoot, 'tests/fixtures/gurps-testing.md'), path.join(dir, 'gurps-testing.md'));
  });

  after(async () => {
    await Promise.all(servers.map((s) => s.stop()));
    await rm(dir, { recursive: true, force: true });
  });

  test('adds rules tools and names the books, behind the token', async () => {
    const server = await ready(await start(startLibraryServer, { MCP_TOKEN: token }));
    const names = await toolNames(server);
    assert.deepEqual(names.slice(-2), ['search_rules', 'read_rules']);
    assert.ok(names.includes('get_character'));
    const { instructions } = (await rpc(server, 'initialize', { protocolVersion: '2025-11-25' })).result;
    assert.match(instructions, /repeating_<section>_<rowId>_<field>/);
    assert.match(instructions, /The books are: GURPS Testing \(T1-T3\)/);

    const found = await tool(server, 'search_rules', { query: 'flaming teapot' });
    assert.match(found.content[0].text, /^## T1 · GURPS Testing › Flaming Teapot\n\n\*\*Missile\*\*/);
    assert.equal((await tool(server, 'read_rules', { ref: 'T2' })).content[0].text.split('\n\n')[0], '# T2 · GURPS Testing');
    assert.match((await tool(server, 'read_rules', { ref: 'T2', pages: 2 })).content[0].text, /# T3 · GURPS Testing\n\n# BREAKAGE/);

    const missing = await tool(server, 'read_rules', { ref: 'T9' });
    assert.equal(missing.isError, true);
    assert.equal(missing.content[0].text, 'There is no page T9. The books are: GURPS Testing (T1-T3).');
    assert.equal((await tool(server, 'search_rules', { query: 'x', book: 'Q' })).isError, true);
    assert.equal((await tool(server, 'search_rules', { query: 'x', limit: 0 })).isError, true);
    assert.equal((await tool(server, 'read_rules', { ref: 'T1', pages: 9 })).isError, true);
    assert.match((await tool(server, 'search_rules', { query: 'dragon' })).content[0].text, /^Nothing found for "dragon"/);
  });

  test('leaves the rules out without a token', async () => {
    const server = await start(startLibraryServer, {});
    const res = await post(server.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.ok(!res.body.result.tools.some((t) => t.name.endsWith('_rules')));
  });

  test('won’t start with the rules in a folder it serves, and starts without rules or a token', async () => {
    await assert.rejects(startServer({ env: { RULES_DIR: path.join(projectRoot, 'public'), MCP_TOKEN: token } }), /exited with code 1/);
    const server = await start(startServer, { RULES_DIR: '', RULES_FOLDER_ID: 'some-folder' });
    assert.equal((await post(server.url, { jsonrpc: '2.0', id: 1, method: 'ping' })).status, 404, 'no library, no rules: no /mcp');
  });

  test('answers with only the rules when there is no library', async () => {
    const server = await ready(await start(startServer, { MCP_TOKEN: token }));
    assert.deepEqual(await toolNames(server), ['search_rules', 'read_rules']);
    const { instructions } = (await rpc(server, 'initialize', { protocolVersion: '2025-11-25' })).result;
    assert.doesNotMatch(instructions, /repeating_/);
    assert.match(instructions, /^This server has the text of the group's GURPS rulebooks/);
  });
});
