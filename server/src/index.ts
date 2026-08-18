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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits between replay attempts: a recycling container needs seconds, not
 * milliseconds, before it answers again. */
const RETRY_DELAYS_MS = [1500, 4000];

async function rpc(method: string, params: unknown, retriesLeft = RETRY_DELAYS_MS.length): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId !== null) headers["mcp-session-id"] = sessionId;

  requestId += 1;
  let response: Response;
  try {
    response = await fetch(REMOTE, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not reach the SOS documentation service at ${REMOTE} (${detail}). ` +
        `The service may be down, or SOS_MCP_URL may need to point at the right endpoint.`
    );
  }

  const newSession = response.headers.get("mcp-session-id");
  if (newSession !== null) sessionId = newSession;

  const recycle = async (): Promise<unknown> => {
    await sleep(RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - retriesLeft]);
    sessionId = null;
    await handshake();
    return rpc(method, params, retriesLeft - 1);
  };

  // A recycled container or expired session answers 4xx/5xx: back off,
  // handshake again and replay the call.
  if (!response.ok) {
    if (retriesLeft > 0) return recycle();
    throw new Error(`SOS docs endpoint answered ${response.status} for ${method}`);
  }

  const body = await parseBody(response);
  if (body.error !== undefined) {
    // Some deployments report a lost session in-band rather than as a 4xx.
    if (retriesLeft > 0 && /session/i.test(body.error.message)) return recycle();
    throw new Error(`${body.error.message} (remote code ${body.error.code})`);
  }
  // A container mid-restart can answer 200 with an empty body; the backoff
  // rides over it.
  if (body.result === undefined) {
    if (retriesLeft > 0) return recycle();
    throw new Error(
      `empty response from the SOS docs endpoint for ${method} — the service may still be starting; try again shortly`
    );
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
    0
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
  // A failed handshake must not be cached: the endpoint being down at the
  // first call would otherwise poison every later one, long after it is back.
  ready ??= handshake().catch((error: unknown) => {
    ready = null;
    throw error;
  });
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
  // Failures come back as tool results rather than protocol errors, so the
  // agent reads an actionable sentence instead of a bare -32603.
  try {
    await ensureReady();
    return (await rpc("tools/call", {
      name: request.params.name,
      arguments: request.params.arguments ?? {},
    })) as { content: unknown[] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `SOS documentation service error: ${detail}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
