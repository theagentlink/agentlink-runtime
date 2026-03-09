#!/usr/bin/env node
/**
 * AgentLink MCP Signer
 *
 * ⚠️  SECURITY: This process reads AGENT_PRIVATE_KEY from .env.
 *     The private key NEVER leaves this process.
 *     Claude only receives { signature, timestamp, nonce }.
 *     NEVER log the private key or canonical message.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const nacl = require('tweetnacl');
const bs58 = require('bs58');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// ⚠️  Private key is read once at startup and never exposed
function getKeyPair() {
  const privateKeyBase58 = process.env.AGENT_PRIVATE_KEY;
  if (!privateKeyBase58) {
    throw new Error('AGENT_PRIVATE_KEY not set in .env');
  }
  const privateKeyBytes = bs58.decode(privateKeyBase58);
  // Ed25519 secret key is 64 bytes (private 32 + public 32)
  // If only 32 bytes provided, derive the full keypair
  if (privateKeyBytes.length === 32) {
    return nacl.sign.keyPair.fromSeed(privateKeyBytes);
  }
  return nacl.sign.keyPair.fromSecretKey(privateKeyBytes);
}

const server = new Server(
  { name: 'agentlink-mcp-signer', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'sign_request',
      description: 'Sign an AgentLink API request. Returns signature, timestamp, nonce only. Private key never exposed.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action name (e.g., bid, acknowledge, deliver)' },
          pubkey: { type: 'string', description: 'Agent public key (base58)' },
          body: { type: 'object', description: 'Request body to sign' }
        },
        required: ['action', 'pubkey', 'body']
      }
    },
    {
      name: 'get_pubkey',
      description: 'Get the agent public key. Safe — returns public key only.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'generate_idempotency_key',
      description: 'Generate a fresh UUID v4 for idempotency headers.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'get_mode',
      description: 'Get the current runtime mode (subscription or api). Safe — no secrets.',
      inputSchema: { type: 'object', properties: {} }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'sign_request') {
    const { action, pubkey, body } = args;

    const timestamp = Date.now().toString();
    const nonce = uuidv4();

    // Build canonical message — NEVER log this
    const bodyHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');
    const canonical = `action=${action}|publicKey=${pubkey}|timestamp=${timestamp}|nonce=${nonce}|bodyHash=${bodyHash}`;

    // Sign — private key used here and NEVER returned
    const keyPair = getKeyPair();
    const messageBytes = Buffer.from(canonical, 'utf8');
    const signatureBytes = nacl.sign.detached(messageBytes, keyPair.secretKey);
    const signature = bs58.encode(signatureBytes);

    // Return ONLY the safe values
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ signature, timestamp, nonce })
        }
      ]
    };
  }

  if (name === 'get_pubkey') {
    const pubkey = process.env.AGENT_PUBKEY;
    if (!pubkey) {
      throw new Error('AGENT_PUBKEY not set in .env');
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ pubkey }) }]
    };
  }

  if (name === 'generate_idempotency_key') {
    return {
      content: [{ type: 'text', text: JSON.stringify({ key: uuidv4() }) }]
    };
  }

  if (name === 'get_mode') {
    const mode = process.env.MODE || 'subscription';
    return {
      content: [{ type: 'text', text: JSON.stringify({ mode }) }]
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so it doesn't interfere with MCP stdio protocol
  process.stderr.write('AgentLink MCP Signer running. Private key isolated.\n');
}

main().catch((err) => {
  process.stderr.write(`MCP Signer error: ${err.message}\n`);
  process.exit(1);
});
