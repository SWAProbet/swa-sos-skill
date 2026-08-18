# SOS integration troubleshooting

Read this when the quick table in SKILL.md has not resolved it. Ordered by how
often each one is actually the cause.

## Contents

- [Silent failures](#silent-failures)
- [Connection problems](#connection-problems)
- [Message problems](#message-problems)
- [Recovery problems](#recovery-problems)
- [Market mapping problems](#market-mapping-problems)
- [What to send SWA](#what-to-send-swa)

## Silent failures

These produce no error, which is why they dominate the list.

### Connected, heartbeats arriving, no odds

The queue is bound to routing keys that no message matches. `bindingPatterns`
defaults to `['mma.live.#', 'system.live.alive.#']`, so any sport other than MMA
receives only the heartbeats — which is exactly what makes this confusing, since
the connection looks healthy.

Set the sport prefix explicitly:

```typescript
bindingPatterns: ["tennis.live.#", "system.live.alive.#"],
```

Keep `system.live.alive.#` in the list. Dropping it stops the heartbeats, which
means `aliveTimeoutMs` fires and the client starts recovering repeatedly.

### Fixtures are for the wrong sport

`getFixtures()` requests MMA regardless of what you are integrating and returns
a 200. Call the REST endpoint directly:

```
GET {apiHost}/uof-api/v1/sports/{sport}/events/json
Authorization: <your API key>
```

### Handler never fires and no error is logged

Check the event name against `sos_client_reference`. `recoveryFailed` does not
exist — recovery failures arrive on `error`. Listening for a name the client
never emits is indistinguishable from a quiet feed.

## Connection problems

### Nothing arrives, not even `alive`

Work outwards:

1. `error` handler attached? Without one, connection errors are easy to miss.
2. `accessToken` correct and not expired.
3. `amqpHost` reachable from the deployment environment, TLS port open.
4. Virtual host and exchange as published by `sos_connection` — a wrong vhost
   fails at connect, a wrong exchange fails silently.

### Connects then immediately disconnects, repeatedly

Usually credentials accepted at TCP level but rejected at AMQP level, or two
consumers using the same exclusive queue name. The client reconnects on its own,
so this shows up as a loop rather than a single failure.

### The MCP endpoint is unreachable (405, or HTML instead of JSON-RPC)

A 405 on POST, or the docs website's HTML coming back from the MCP path,
almost always means an **old clone with a stale default endpoint**: run
`git pull && npm run build` — the server now defaults to
`https://docs.swa.one/docs/mcp/sos`, which is public (no VPN). Otherwise
set `SOS_MCP_URL` to the right environment. While it is down, follow the
skill's hard rule: no invented examples, no fabricated markets, no
guessed sports — and no probing alternative paths on production
gateways.

## Message problems

### XML fails to parse

The SDK deserialises for you; if you are parsing raw XML you are likely
consuming with a plain AMQP client. Compare against the worked examples from
`sos_message_reference` — pass the message type, e.g. `odds-change`.

### Odds look stale

Check `alive` is still arriving. A producer that has stopped sending heartbeats
has stopped sending odds too; the last values you hold are the last that were
published, not current.

### Duplicate or out-of-order odds after a blip

Expected during recovery — you are replaying history. See below.

## Recovery problems

### `recoveryStarted` fires but `recoveryCompleted` never does

The replay window may be larger than the retention period, or the REST API is
unreachable while AMQP is fine — recovery is driven over REST even though the
messages arrive over AMQP. Check `apiHost` connectivity separately from
`amqpHost`.

### Recovery loops

Almost always the heartbeats: if `system.live.alive.#` is missing from
`bindingPatterns`, no `alive` arrives, `aliveTimeoutMs` expires, recovery
triggers, and the cycle repeats.

### Odds jump around during recovery

Correct behaviour. Treat everything between `disconnected` and
`recoveryCompleted` as provisional and only trust state once recovery completes.

## Market mapping problems

### A market id matches nothing

Market ids are templates. `fight_winner_bin{ }` has a placeholder filled per
event; `fight_winner_3way_{red|draw|blue}` enumerates alternatives. Parse the
template or map on market name — do not compare as fixed strings.

### A market has no selections

If `notOffered` is true, the market genuinely does not apply to that variant —
a round-range market on a one-round fight, for example. Skip it. If `notOffered`
is false and there are still no selections, that is worth raising.

### A BetBuilder combination is rejected unexpectedly

Check `sos_betbuilder_combinations` for that leg. The relation is symmetric, so
the exclusion appears on both legs; you only need to check one direction.

## What to send SWA

Include all of these — the first three are what make a report actionable:

- The **sport** and your **`bindingPatterns`** verbatim
- A **timestamp range in UTC** for when the problem occurred
- The **event id** for a specific affected event, if there is one
- Whether `alive` was arriving during that window
- Your `aliveTimeoutMs` and `autoRecover` settings
- The last `error` payload, with the message text
- Whether the problem survives a reconnect

Do not include your `accessToken`.
