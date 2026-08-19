# swa-sos-skill

The client side of a **SWA Odds Service (SOS)** integration: the MCP server a
partner's agent runs, and the Claude skill that drives it.

## What is here

```
server/
└── src/index.ts                    the SOS MCP server (stdio), installable,
                                    fronts the live SOS documentation service,
                                    so every answer is the published content
sos-integration/
├── SKILL.md                        the integration skill
└── references/troubleshooting.md   loaded on demand, when something is wrong
dist/
└── sos-integration.skill           the packaged artefact partners receive
```

## Running the MCP server

```
cd server && npm install && npm run build
```

Then in any MCP client:

```json
{
  "mcpServers": {
    "swa-odds-service": {
      "command": "node",
      "args": ["<path>/server/dist/index.js"]
    }
  }
}
```

`SOS_MCP_URL` overrides the documentation endpoint (defaults to production).
The server is a front, not a re-implementation: content is answered by the SOS
documentation service, which is what keeps it current the moment an editor
saves. Remote-capable clients can also connect straight to the streamable-HTTP
endpoint at `/docs/mcp/sos` without this package.

## How it fits with the MCP

The two are complementary rather than duplicative:

- The **MCP server** reads the live documentation out of the CMS and answers
  what the feed contains: market catalogues, message schemas, connection
  details, recovery behaviour.
- The **skill** carries the procedure and the traps: what order to bring an
  integration up in, and which failure to suspect first.

The dividing line is whether an editor could change it. If they could, it
belongs in the CMS and reaches Claude through the MCP, so it stays current
without anyone repackaging a skill. That is why the skill tells Claude to call
`sos_client_reference` before writing any client configuration rather than
restating the options here: the authoritative version comes from the live docs.

## Giving it to a partner

Send them `dist/sos-integration.skill` to install, then have them point their
client at the MCP server:

```json
{
  "mcpServers": {
    "swa-odds-service": {
      "type": "http",
      "url": "https://<swa-host>/docs/mcp/sos"
    }
  }
}
```

No credentials. That server is read-only and unauthenticated because everything
it returns is already published documentation: the internal server at
`/docs/mcp` is the one that needs an admin API key.

## Rebuilding after an edit

`dist/` is what partners actually receive, so it has to be regenerated whenever
the source changes:

```bash
python -m scripts.package_skill <path-to>/swa-sos-skill/sos-integration
```

`package_skill` comes from Anthropic's skill-creator skill. It validates the
frontmatter before packaging, so a broken skill fails here rather than on a
partner's machine.

## Related

| Repo | Why you would open it |
|---|---|
| [cypher](https://github.com/SWAProbet/cypher) | The docs site, the CMS, and both MCP servers |
| [swa-uof-sdk](https://github.com/SWAProbet/swa-uof-sdk) | The client SDK the skill teaches. Still named `uof`: it predates the SOS rename and is deliberately unchanged so existing integrations keep working |
