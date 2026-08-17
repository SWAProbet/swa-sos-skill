#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

/**
 * The SWA Odds Service MCP, from the client's side of the integration.
 *
 * Partners run this locally (stdio) in Claude Desktop, Claude Code, or any
 * other MCP client. Every tool — the market catalogues, message schemas,
 * connection and recovery documentation, BetBuilder combinations, the SDK
 * reference — is answered by the live SOS documentation service, so what an
 * agent reads through this server is exactly what is published, current the
 * moment an editor saves.
 *
 * This is deliberately a front, not a re-implementation: the content lives in
 * the SOS documentation CMS and is served from its MCP endpoint (streamable
 * HTTP). Duplicating the rendering here would mean answers that age. What
 * this package adds is the client-side packaging — an installable server that
 * works over stdio everywhere, with the endpoint as configuration:
 *
 *   SOS_MCP_URL   defaults to the production docs endpoint.
 *
 * Ships with the sos-integration Claude skill in this repository, which
 * carries the integration *procedure*; this server carries the *content*.
 */

const REMOTE = process.env.SOS_MCP_URL ?? "https://api.probet.live/docs/mcp/sos";
const PROTOCOL_VERSION = "2025-03-26";

interface JsonRpcResponse {
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

let sessionId: string | null = null;
let requestId = 0;

/** Parse a streamable-HTTP response body: plain JSON or SSE `data:` frames. */
async function parseBody(response: Response): Promise<JsonRpcResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  const raw = await response.text();
  if (contentType.includes("text/event-stream")) {
    const frames = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line !== "");
    const last = frames[frames.length - 1];
    if (last === undefined) throw new Error("empty event stream from remote");
    return JSON.parse(last) as JsonRpcResponse;
  }
  if (raw === "") return {};
  return JSON.parse(raw) as JsonRpcResponse;
}

async function rpc(method: string, params: unknown, allowRetry = true): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId !== null) headers["mcp-session-id"] = sessionId;

  requestId += 1;
  const response = await fetch(REMOTE, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
  });

  const newSession = response.headers.get("mcp-session-id");
  if (newSession !== null) sessionId = newSession;

  // A recycled container or expired session answers 4xx: handshake again once.
  if (!response.ok) {
    if (allowRetry && (response.status === 400 || response.status === 404)) {
      sessionId = null;
      await handshake();
      return rpc(method, params, false);
    }
    throw new Error(`SOS docs endpoint answered ${response.status} for ${method}`);
  }

  const body = await parseBody(response);
  if (body.error !== undefined) {
    throw new Error(`${body.error.message} (remote code ${body.error.code})`);
  }
  return body.result;
}

async function handshake(): Promise<void> {
  await rpc(
    "initialize",
    {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "swa-sos-mcp", version: "0.1.0" },
      capabilities: {},
    },
    false
  );
  // Fire-and-forget per spec; the remote needs it to consider the session live.
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId !== null) headers["mcp-session-id"] = sessionId;
  await fetch(REMOTE, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => undefined);
}

let ready: Promise<void> | null = null;
const ensureReady = (): Promise<void> => {
  ready ??= handshake();
  return ready;
};

const server = new Server(
  { name: "swa-odds-service", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  await ensureReady();
  return (await rpc("tools/list", {})) as { tools: unknown[] };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await ensureReady();
  return (await rpc("tools/call", {
    name: request.params.name,
    arguments: request.params.arguments ?? {},
  })) as { content: unknown[] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
