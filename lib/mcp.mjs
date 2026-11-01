// A remote MCP server at /mcp, so each player's Claude can read the group's
// characters (tools in lib/mcp-tools.mjs). Streamable HTTP without sessions or
// server-sent events: every POST carries one JSON-RPC message (or a batch, for
// 2025-03-26 clients) and gets a JSON answer. Written by hand to keep the server
// free of dependencies; it handles initialize, ping, tools/list and tools/call.
import { readBody, send } from './api.mjs';
import { ToolError, tools } from './mcp-tools.mjs';

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

const INSTRUCTIONS = `This server holds the GURPS 4th Edition characters of one gaming group, in the format of the Roll20 GURPS character sheet, as kept in the group's shared library (the same characters the group's web app shows).
Find a character with list_characters, or pass its name to the other tools. get_character gives a readable summary with the levels the sheet computes; detail "attributes" gives the raw sheet attributes.
A character is a set of sheet attributes (e.g. strength_points, dodge) plus repeating sections such as repeating_skills, whose fields are stored per row as repeating_<section>_<rowId>_<field>. sheet_fields lists the fields the sheet has.
Every save is kept as a new version, so get_character_history and get_character_version show how a character changed.
The group rolls dice in Roll20: success rolls there look like /roll {3d6[Broadsword],0d0+99}<11 (the 0d0+99 makes Roll20 compare the total), damage like /roll {1d6[Swing]+2, {0}}kh1.`;

class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function handleMcp(req, res, { library, sheet, version }) {
  if (!library) return send(res, 404, { error: 'This server has no shared character library.' });
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

  const context = { library, sheet: sheet(), version };
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
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })) };
    case 'tools/call':
      return callTool(params, context);
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

async function callTool({ name, arguments: args = {} }, context) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new RpcError(-32602, `Unknown tool: ${name}`);
  try {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ToolError('The arguments must be an object.');
    for (const key of tool.inputSchema.required || []) {
      if (typeof args[key] !== 'string' || !args[key].trim()) throw new ToolError(`"${key}" is required.`);
    }
    for (const [key, value] of Object.entries(args)) {
      const schema = tool.inputSchema.properties[key];
      if (!schema) throw new ToolError(`Unknown argument "${key}".`);
      if (typeof value !== 'string' || (schema.enum && !schema.enum.includes(value))) {
        throw new ToolError(`"${key}" must be ${schema.enum ? `one of ${schema.enum.join(', ')}` : 'a string'}.`);
      }
    }
    if (!context.library.ready) throw new ToolError('The character library is still loading. Try again in a moment.');
    return { content: [{ type: 'text', text: await tool.run(args, context) }] };
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    return { content: [{ type: 'text', text: err.message }], isError: true };
  }
}
