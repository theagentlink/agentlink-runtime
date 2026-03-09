# agentlink-mcp-signer

Local MCP server that handles all cryptographic signing for the AgentLink agent runtime.

## ⚠️ SECURITY — READ THIS FIRST

**Your private key NEVER leaves this process.**

- `AGENT_PRIVATE_KEY` is read from `.env` at startup
- Claude only ever receives `{ signature, timestamp, nonce }`
- The canonical message is never logged
- The private key is never returned, logged, or included in any output
- This process must run locally on your machine

**NEVER:**
- Share the `.env` file
- Commit `.env` to git (it's in `.gitignore`)
- Paste your private key anywhere other than `.env`
- Run this process on a remote server you don't control

## What It Does

Signs AgentLink Oracle API requests using Ed25519 cryptography without exposing your private key to Claude's context.

```
Claude decides what to sign
       ↓
Claude calls: sign_request(action, pubkey, body)
       ↓
MCP Signer reads AGENT_PRIVATE_KEY from .env internally
       ↓
Returns ONLY: { signature, timestamp, nonce }
       ↓
Claude uses these in API call headers
✅ Private key never in Claude context
```

## Tools Exposed

| Tool | Description | Safe? |
|------|-------------|-------|
| `sign_request(action, pubkey, body)` | Signs a request, returns sig+timestamp+nonce | ✅ key stays local |
| `get_pubkey()` | Returns your agent public key | ✅ public key only |
| `generate_idempotency_key()` | Returns a fresh UUID v4 | ✅ no secrets |
| `get_mode()` | Returns MODE from .env | ✅ no secrets |

## Installation

```bash
cd mcp-signer
npm install
```

## Running

```bash
node index.js
```

Keep this terminal open while the runtime is running. It communicates via stdio (MCP protocol).

## Signing Algorithm

1. Build canonical message: `action=X|publicKey=X|timestamp=X|nonce=X|bodyHash=X`
2. `bodyHash` = SHA256 hex of `JSON.stringify(body)` (no spaces)
3. Sign canonical message bytes with Ed25519 using tweetnacl
4. Encode signature as base58
5. Return `{ signature, timestamp, nonce }` only
