---
name: sos-integration
description: Integrate an application with the SWA Odds Service (SOS), connecting to the live odds feed, consuming odds changes, settlements and heartbeats over AMQP, handling recovery, and mapping SWA market templates onto your own markets. Use this whenever someone mentions SOS, the SWA Odds Service, the SWA odds feed, @swa-voltron/sos-sdk, SosClient, or is wiring up live MMA, boxing, tennis, table tennis or volleyball odds from SWA, including when they only describe the symptom ("my consumer connects but no messages arrive", "odds stopped after a disconnect", "what do these market ids mean") without naming the product.
---

# Integrating with the SWA Odds Service

SOS delivers live odds, settlements and control messages over AMQP. Partners
bind a queue to a topic exchange and consume XML messages, usually through the
TypeScript SDK.

Most failed integrations fail quietly rather than loudly: a queue bound to
nothing receives no messages and no error, and a fixtures call returns the wrong
sport's data with a 200. So the ordering below front-loads the things that fail
silently, before anything that would throw.

## Use the MCP server as the source of truth

If the SOS MCP server is connected (`swa-odds-service`, at `/docs/mcp/sos`),
prefer it over recalling anything from memory. It reads the live documentation,
so it reflects what is actually published rather than what was true when this
skill was written.

| Question | Tool |
|---|---|
| Which sports are published? | `sos_overview`: the list is appended at the end |
| What is SOS, how do messages flow? | `sos_overview` |
| How do I connect and get a first message? | `sos_quickstart` |
| What are the exact client options, events, methods? | `sos_client_reference` |
| Broker topology, exchange, routing keys | `sos_connection` |
| What does an `odds_change` look like? | `sos_message_reference` |
| What happens after a disconnect? | `sos_recovery` |
| Which markets will I receive? | `sos_market_catalogue` |
| Which legs can be combined? | `sos_betbuilder_combinations` |
| How do I authenticate: API key, JWT, AMQP credentials? | `sos_authentication` |
| Which events exist, with the ids to map onto my own? | `sos_fixtures` |
| Current odds for one event over REST, not the queue? | `sos_probabilities` |

Call `sos_client_reference` before writing any client configuration. It returns
the published getting-started, fixtures, probabilities, recovery and message
pages, including the constructor options with their defaults.

## When the MCP is unreachable: stop, do not improvise

The only safe fallbacks are the published docs site and the specifics this
file itself confirms. Everything else is a hard rule:

- **Never generate example payloads, market lists or market ids from general
  betting knowledge.** They will be wrong three ways at once: format (the
  feed is XML over AMQP: a JSON "price update" is wrong by construction),
  ids (the feed's market `id` is the `marketId` that `sos_market_catalogue`
  lists for that market, and nothing else), and coverage (invented markets
  look authoritative exactly where being wrong is expensive). A worked example has one source:
  `sos_message_reference`, live.
- **The published sports list is exhaustive.** `sos_overview` ends with it.
  Asked about any sport not on it, football, basketball, anything, the
  answer is "not offered by SOS", never an example. Do not pick a
  "different sport" that SOS does not carry.
- **Fix the connection instead of working around it.** In order: (1)
  `git pull && npm run build`: the default endpoint is
  `https://docs.swa.one/docs/mcp/sos` and older clones default to a host
  that never served it; (2) set `SOS_MCP_URL` explicitly if you need a
  different environment; (3) the endpoint is public: no VPN needed. If it
  still fails, say so and ask whoever owns the docs. **Do not path-probe
  production gateways guessing routes.**

## Three things that will cost you an afternoon

**The package is `@swa-voltron/sos-sdk`.** It is published under the
`swa-voltron` scope (the `swa` npm org was taken), and the class is `SosClient`.
Teach those two names and no others.

```bash
npm install @swa-voltron/sos-sdk
```

```typescript
import { SosClient } from "@swa-voltron/sos-sdk";
```

**Set `sport`.** It defaults to `mma`. The client derives its queue bindings
(`<sport>.live.#`, `system.live.alive.<sport>` and the legacy
`system.live.alive.-`) and its fixtures path from it. Integrating tennis with
the default binds the queue to MMA: no tennis messages and no error. Pass
`bindingPatterns` only to narrow what you receive, and keep your sport's alive
key in it. Never bind `system.live.alive.#`: every sport publishes its
heartbeat to the same exchange, so another sport's heartbeat would hide an
outage of yours.

```typescript
sport: "tennis",
```

**A replayed message arrives under your queue's name.** Recovery delivers
straight to your queue, so the AMQP routing key of a replayed message is the
queue name. The key it was first published on is in the `x-sos-routing-key`
header. The SDK puts both on every event as `meta`: `meta.routingKey` is the
original key, `meta.replayed` says whether it came from a replay, and
`meta.messageId` is the id the message was first delivered with. Deduplicate
on `meta.messageId`.

Confirm all three against `sos_client_reference` rather than trusting this list
if the two ever disagree: the MCP reads the live docs.

## Connecting

Work in this order, because each step's failure mode is easier to diagnose in
isolation than in combination.

1. **Confirm credentials and hosts.** `accessToken`, `amqpHost` and `apiHost`
   are all required. Get them from SWA: they are per-partner.
2. **Set `sport`** before the first connect, per above.
3. **Connect and log raw events first.** Attach `connected`, `disconnected` and
   `error` handlers and confirm you see `connected` and then `alive` messages
   before writing any odds-handling logic. If `alive` arrives but `oddsChange`
   never does, the sport or the binding patterns are wrong: not the credentials.
4. **Then handle `oddsChange`, `betSettlement` and `betStop`.**

```typescript
const client = new SosClient({
  accessToken: process.env.SOS_ACCESS_TOKEN,
  amqpHost: "amqps://<broker-host>",
  apiHost: "https://<api-host>",
  sport: "<sport>",
  aliveTimeoutMs: 30_000,
  autoRecover: true,
});

client.on("connected", () => console.log("connected"));
client.on("alive", () => console.log("producer alive"));
client.on("oddsChange", (event) => { /* … */ });
client.on("error", (err) => console.error(err.message));

await client.connect();
```

## Events, and the one that does not exist

The client emits these events:

- Feed: `oddsChange`, `betSettlement`, `betStop`, `betCancel`, `fixtureChange`,
  `snapshotComplete` and `alive`. Each carries `meta`.
- Connection: `connected` and `disconnected`.
- Recovery: `recoveryStarted` and `recoveryCompleted`.
- `error`.

There is **no `recoveryFailed` event**: a failed recovery surfaces on `error`
like anything else. Older documentation described one, along with a client
class that was never exported. If you find code listening for either, it has
been silently dead.

## Recovery and liveness

`alive` is the producer heartbeat. If none arrives within `aliveTimeoutMs`
(30s by default), the client treats the producer as down. With `autoRecover`
left on, reconnecting requests a replay of what was missed, and you get
`recoveryStarted` with an estimated message count, then `recoveryCompleted`.

Treat odds received between `disconnected` and `recoveryCompleted` as
provisional: during recovery you are replaying history, so a market may move
several times in quick succession before settling on its current state. Ask
`sos_recovery` for the detail, and drive recovery through the REST API only if
you are consuming with a plain AMQP client rather than the SDK.

The replay contract:

- Recovery delivers into the consumer's own exclusive queue, named by
  `consumer_queue`. No separate recovery queue is created.
- A replayed message's routing key is the queue name. Its original key is in
  the `x-sos-routing-key` header (`meta.routingKey` in the SDK).
- A replayed message keeps the `messageId` it was first delivered with.
- `snapshot_complete` carrying the request id arrives on the same queue after
  every replayed message. It ends the replay. `GET
  /recovery/{producer}/status` reports `failed` with an `error` when a replay
  cannot finish.
- Apply the same deduplication, idempotent handling and acknowledgement rules
  as for live traffic.
- Checkpoint the producer, message timestamp and `messageId` after each
  successfully applied message, and start recovery from that timestamp.
- Messages are retained for replay for 72 hours by default.

Two REST guides sit beside the feed: `sos_fixtures` lists every event the feed
holds, with its URN, competitors, scheduled time and status, so ids can be
mapped before an event goes live (filters are not validated: a status the feed
does not use returns an empty list, not an error), and `sos_probabilities`
returns the current odds for one event, market, or market and specifier set in
the HTTP response body. `sos_authentication` covers the `X-API-Key` header, JWT
bearer tokens, and the separate AMQP credentials.

## Reading the market catalogue

`sos_market_catalogue` returns what a sport actually publishes. Two conventions
surprise people:

**A market has two identifiers.** The feed's `<market id>` is numeric: it is
the `marketId` the catalogue lists. Map feed messages on `marketId`, and
outcomes on each outcome's `outcomeId`. The `templateId` is SWA's catalogue
name for the market, and it is a template: a braced blank marks a value
supplied per event (`fight_winner_bin{ }`), and a braced list enumerates
alternatives (`fight_winner_3way_{red|draw|blue}`). The feed never sends a
`templateId`.

**`notOffered` means the market does not apply.** Some markets exist in the
catalogue but are not offered for a particular variant: a round-range market on
a one-round fight, for instance. Those come back with `notOffered: true` and no
selections, rather than being absent. Skip them rather than rendering an empty
market.

For BetBuilder, `sos_betbuilder_combinations` gives each leg and what it cannot
be combined with. The relation is symmetric: a blocked pair appears on both
legs, so checking either direction is enough, and anything not listed as
excluded is combinable.

## When something is wrong

Match the symptom, since the causes are unrelated:

| Symptom | Look at |
|---|---|
| Connects, `alive` arrives, no odds | `sport`, or the sport prefix in your own `bindingPatterns` |
| Nothing at all, not even `alive` | Credentials, `amqpHost`, network path to the broker |
| Fixtures are for the wrong sport | `sport`: `getFixtures()` asks for the configured sport |
| Odds stop after a network blip | `autoRecover`, and whether `recoveryCompleted` fires |
| A market id does not match anything | Map on `marketId`, not `templateId`: see above |
| The same message applied twice after a blip | Deduplicate on `meta.messageId` |
| Import fails | The package is `@swa-voltron/sos-sdk`; nothing was ever published under the `@swa` scope |

`references/troubleshooting.md` has the longer version, including what to log
when escalating to SWA.
