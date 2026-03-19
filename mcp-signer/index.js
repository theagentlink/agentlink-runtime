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

/**
 * Core signing function — signs canonical fields and returns safe values only.
 * Private key is used here and NEVER returned or logged.
 */
function signFields(fields) {
  const timestamp = Date.now();
  const nonce = uuidv4();

  const parts = { ...fields, timestamp };
  const canonical = Object.entries(parts)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('|');

  const keyPair = getKeyPair();
  const messageBytes = Buffer.from(canonical, 'utf8');
  const signatureBytes = nacl.sign.detached(messageBytes, keyPair.secretKey);
  const signature = bs58.encode(signatureBytes);

  return { signature, timestamp, nonce };
}

const server = new Server(
  { name: 'agentlink-mcp-signer', version: '1.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ─── Action-specific signing tools ─────────────────────────────────
    {
      name: 'sign_bid',
      description: 'Sign a bid request. Returns { signature, timestamp, nonce, workerPubkey } — use ALL returned values in the POST body.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Job ID to bid on' },
          amount: { type: 'number', description: 'Bid amount in SOL' }
        },
        required: ['jobId', 'amount']
      }
    },
    {
      name: 'sign_acknowledge_job',
      description: 'Sign a job acknowledgment. Returns { signature, timestamp, nonce, workerPubkey } — use ALL returned values in the POST body.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Job ID to acknowledge' }
        },
        required: ['jobId']
      }
    },
    {
      name: 'sign_execution_event',
      description: 'Sign an execution event. Returns { signature, timestamp, nonce, workerPubkey } — use ALL returned values in the POST body.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Job ID' },
          runId: { type: 'string', description: 'Run ID (e.g. run-{first8charsOfJobId})' },
          state: { type: 'string', enum: ['STARTED', 'PROGRESS', 'SUCCEEDED', 'FAILED'], description: 'Execution state' }
        },
        required: ['jobId', 'runId', 'state']
      }
    },
    {
      name: 'sign_deliver',
      description: 'Sign a delivery. Returns { signature, timestamp, nonce, workerPubkey } — use ALL returned values in the POST body.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Job ID' },
          url: { type: 'string', description: 'Delivery URL (GitHub repo or hosted URL)' }
        },
        required: ['jobId', 'url']
      }
    },
    {
      name: 'sign_request_delivery_repo',
      description: 'Sign a delivery repo access request. Returns { signature, timestamp, nonce, workerPubkey } — use ALL returned values in the POST body.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Job ID' }
        },
        required: ['jobId']
      }
    },
    // ─── Legacy generic signing tool (kept for backward compatibility) ──
    {
      name: 'sign_request',
      description: 'Generic sign tool (prefer action-specific tools above). Returns signature, timestamp, nonce only. Private key never exposed.',
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
    // ─── Utility tools ─────────────────────────────────────────────────
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
      description: 'Get the current runtime mode, oracleUrl, and deliveryUrl.',
      inputSchema: { type: 'object', properties: {} }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const workerPubkey = process.env.AGENT_PUBKEY;

  // ─── Action-specific signing tools ───────────────────────────────────

  if (name === 'sign_bid') {
    const { jobId, amount } = args;
    const result = signFields({ action: 'bid', worker: workerPubkey, jobId, amount: Number(amount) });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...result, workerPubkey }) }]
    };
  }

  if (name === 'sign_acknowledge_job') {
    const { jobId } = args;
    const result = signFields({ action: 'acknowledge_job', worker: workerPubkey, jobId });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...result, workerPubkey }) }]
    };
  }

  if (name === 'sign_execution_event') {
    const { jobId, runId, state } = args;
    const result = signFields({ action: 'execution_event', worker: workerPubkey, jobId, runId, state });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...result, workerPubkey }) }]
    };
  }

  if (name === 'sign_deliver') {
    const { jobId, url } = args;
    const result = signFields({ action: 'deliver', worker: workerPubkey, jobId, url });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...result, workerPubkey }) }]
    };
  }

  if (name === 'sign_request_delivery_repo') {
    const { jobId } = args;
    const result = signFields({ action: 'request_delivery_repo', worker: workerPubkey, jobId });
    return {
      content: [{ type: 'text', text: JSON.stringify({ ...result, workerPubkey }) }]
    };
  }

  // ─── Legacy generic signing tool ─────────────────────────────────────

  if (name === 'sign_request') {
    const { action, body } = args;
    const result = signFields({ action, ...body });
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }]
    };
  }

  // ─── Utility tools ───────────────────────────────────────────────────

  if (name === 'get_pubkey') {
    if (!workerPubkey) {
      throw new Error('AGENT_PUBKEY not set in .env');
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ pubkey: workerPubkey }) }]
    };
  }

  if (name === 'generate_idempotency_key') {
    return {
      content: [{ type: 'text', text: JSON.stringify({ key: uuidv4() }) }]
    };
  }

  if (name === 'get_mode') {
    const rawMode = process.env.MODE || 'claude-subscription';
    const mode = rawMode === 'subscription' ? 'claude-subscription' : rawMode;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          mode,
          oracleUrl: process.env.AGENTLINK_ORACLE_URL || 'http://localhost:3000',
          deliveryUrl: process.env.AGENTLINK_DELIVERY_URL || 'http://localhost:8001',
        })
      }]
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
