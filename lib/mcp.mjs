// A remote MCP server at /mcp, so each player's Claude can read the group's
// characters and, when the server has them, rulebooks (tools in
// lib/mcp-tools.mjs). Streamable HTTP without sessions or
// server-sent events: every POST carries one JSON-RPC message (or a batch, for
// 2025-03-26 clients) and gets a JSON answer. Written by hand to keep the server
// free of dependencies; it handles initialize, ping, tools/list and tools/call.
//
// With MCP_TOKEN set, only clients with one of its tokens get in: as
// `Authorization: Bearer <token>`, or at the end of the URL, /mcp/<token>, for
// clients that only take a URL (claude.ai's connectors).
import { createHash, timingSafeEqual } from 'node:crypto';
import { readBody, send } from './api.mjs';
import { booksLine, ToolError, toolsFor } from './mcp-tools.mjs';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const CHARACTER_INSTRUCTIONS = `This server holds the GURPS 4th Edition characters of one gaming group, in the format of the Roll20 GURPS character sheet, as kept in the group's shared library (the same characters the group's web app shows).
Find a character with list_characters, or pass its name to the other tools. get_character gives a readable summary with the levels the sheet computes; detail "attributes" gives the raw sheet attributes.
A character is a set of sheet attributes (e.g. strength_points, dodge) plus repeating sections such as repeating_skills, whose fields are stored per row as repeating_<section>_<rowId>_<field>. sheet_fields lists the fields the sheet has.
Every save is kept as a new version, so get_character_history and get_character_version show how a character changed, and nothing is lost by an edit.
create_character, edit_character and import_character run the sheet itself, like a player typing into it: you set what a player sets (attribute points, a skill's name, base, difficulty and points, a trait's points...) and the sheet computes levels, totals and derived values, which can't be set directly. Rows go in repeating sections (skills, spells, traits for advantages, disadvantages, melee, ranged, item...). sheet_fields lists the fields and their choices; choices can be given by label (e.g. difficulty "A").
roll_command gives the Roll20 chat command of any roll, exactly as the web app's roll buttons do, for the player to paste into Roll20.
The group rolls dice in Roll20: success rolls there look like /roll {3d6[Broadsword],0d0+99}<11 (the 0d0+99 makes Roll20 compare the total), damage like /roll {1d6[Swing]+2, {0}}kh1.`;

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const rulesInstructions = (rules) => `This server has the text of the group's GURPS rulebooks. ${booksLine(rules)}
search_rules finds passages by keywords (use the books' English terms, e.g. "Fireball", "Fright Check", "rapid strike"); read_rules reads whole pages by their ref.
Refs are written like the sheet's Ref fields: B243 is page 243 of the Basic Set (Characters B1-B336, Campaigns B337-B575), M23 page 23 of Magic. A trait, skill or spell on a character sheet usually has its ref there.
Answer from the books' text and give the refs, so players can open the page (the group's web app opens a Ref in their own PDF).`;

const instructions = ({ library, rules }) => [library && CHARACTER_INSTRUCTIONS, rules && rulesInstructions(rules)].filter(Boolean).join('\n\n');

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// The tokens in MCP_TOKEN, one or several separated by commas (e.g. one per
// player, so one can be revoked); unset or blank leaves /mcp open. They go in
// URLs, so only letters, digits, - and _, and at least 16 of them.
export function mcpTokensFromEnv(env) {
  const tokens = (env.MCP_TOKEN || '').split(',').map((t) => t.trim()).filter(Boolean);
  // Commas but no token must not leave /mcp open by mistake.
  if (!tokens.length && (env.MCP_TOKEN || '').trim()) throw new Error('it has no token, only commas');
  for (const token of tokens) {
    if (!/^[\w-]{16,}$/.test(token)) throw new Error('each token needs at least 16 letters, digits, - or _');
  }
  return tokens;
}

const digest = (text) => createHash('sha256').update(text).digest();

// Compares digests, so the time taken says nothing about the tokens.
function hasToken(tokens, given) {
  if (!given) return false;
  const hash = digest(given);
  return tokens.reduce((found, token) => timingSafeEqual(digest(token), hash) || found, false);
}

// pathname: /mcp, or /mcp/<token>.
export async function handleMcp(req, res, { library, rules, sheet, version, tokens = [], pathname = '/mcp' }) {
  const inPath = pathname.slice('/mcp/'.length);
  if (inPath && !tokens.length) return send(res, 404, { error: 'This MCP server takes no token; use /mcp.' });
  if (tokens.length) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
    if (!hasToken(tokens, inPath || bearer)) {
      return send(res, 401, { error: 'This MCP server needs its token: at the end of the URL (/mcp/<token>) or as Authorization: Bearer <token>.' }, { 'WWW-Authenticate': 'Bearer realm="gurps-sheet"' });
    }
  }
  if (!library && !rules) return send(res, 404, { error: 'This server has no shared character library or rulebooks.' });
  if (req.method !== 'POST') return send(res, 405, { error: 'This MCP server takes POST requests only; it has no event stream.' }, { Allow: 'POST' });
  // MCP clients such as Claude Code and claude.ai's connectors send no Origin;
  // browsers always do. Refusing every web page also stops DNS rebinding, where
  // the page's origin and the Host header both name the attacker's domain.
  if (req.headers.origin) return send(res, 403, { error: 'Requests from web pages are not allowed.' });
  const protocol = req.headers['mcp-protocol-version'];
  if (protocol && !PROTOCOL_VERSIONS.includes(protocol)) return send(res, 400, { error: `Unsupported MCP protocol version ${protocol}.` });

  const text = await readBody(req, res, 'That request is too big (over 1 MB).');
  if (text === undefined) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return send(res, 400, rpcError(null, -32700, 'Parse error'));
  }
  if (Array.isArray(message) && !message.length) return send(res, 400, rpcError(null, -32600, 'Empty batch'));

  const context = { library, rules, sheet: library ? sheet() : null, version };
  const replies = [];
  for (const m of Array.isArray(message) ? message : [message]) {
    const reply = await answer(m, context);
    if (reply) replies.push(reply);
  }
  if (!replies.length) {
    // Only notifications or responses: nothing to answer.
    res.writeHead(202, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  send(res, 200, Array.isArray(message) ? replies : replies[0]);
}

async function answer(message, context) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return rpcError(message?.id ?? null, -32600, 'Invalid request');
  if (typeof message.method !== 'string') {
    // A response to a request of ours: this server never sends any.
    if ('result' in message || 'error' in message) return null;
    return rpcError(message.id ?? null, -32600, 'Invalid request');
  }
  if (message.id === undefined || message.id === null) return null; // a notification, e.g. notifications/initialized
  try {
    return { jsonrpc: '2.0', id: message.id, result: await call(message.method, message.params || {}, context) };
  } catch (err) {
    if (err instanceof RpcError) return rpcError(message.id, err.code, err.message);
    console.error(`MCP ${message.method} failed:`, err);
    return rpcError(message.id, -32603, 'Internal error');
  }
}

async function call(method, params, context) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'gurps-sheet', title: 'GURPS character sheets', version: context.version },
        instructions: instructions(context),
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: toolsFor(context).map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) };
    case 'tools/call':
      return callTool(params, context);
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

// The top level of the arguments against the tool's schema; the tools check
// what is inside lists and objects themselves.
function checkArguments(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolError('The arguments must be an object.');
  for (const key of schema.required || []) {
    if (args[key] === undefined || (typeof args[key] === 'string' && !args[key].trim())) throw new ToolError(`"${key}" is required.`);
  }
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (!property) throw new ToolError(`Unknown argument "${key}".`);
    const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    const fits =
      property.type === 'integer' ? Number.isInteger(value) : property.type === 'object' ? type === 'object' : type === property.type;
    if (!fits) throw new ToolError(`"${key}" must be ${property.type === 'integer' ? 'a whole number' : `a ${property.type === 'array' ? 'list' : property.type}`}.`);
    if (property.enum && !property.enum.includes(value)) throw new ToolError(`"${key}" must be one of ${property.enum.join(', ')}.`);
  }
}

async function callTool({ name, arguments: args = {} }, context) {
  const tool = toolsFor(context).find((t) => t.name === name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
  try {
    checkArguments(tool.inputSchema, args);
    if (tool.uses === 'rules' ? !context.rules.ready : !context.library.ready) {
      throw new ToolError(`The ${tool.uses === 'rules' ? 'rulebooks are' : 'character library is'} still loading. Try again in a moment.`);
    }
    return { content: [{ type: 'text', text: await tool.run(args, context) }] };
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
}
