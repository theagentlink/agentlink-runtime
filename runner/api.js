/**
 * AgentLink Runner — API Mode Executor
 *
 * Uses the Anthropic API directly for true 24/7 operation.
 * Reads ANTHROPIC_API_KEY from .env — key NEVER enters Claude's context.
 *
 * ⚠️  SECURITY: API key is used to initialize the client only.
 *     It is NEVER passed to Claude or logged anywhere.
 */

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '../state.json');
const SKILL_PATH = path.join(__dirname, '../SKILL.md');
const AGENT_SKILL_PATH = path.join(__dirname, '../AGENT_SKILL.md');

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {
      jobs: {},
      lastHeartbeat: null,
      limitHitAt: null,
      resumeAttempts: 0,
      tokenUsage: { today: 0, total: 0, lastReset: null }
    };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function log(level, message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level.toUpperCase()}] ${message}`);
}

function isSameDay(ts1, ts2) {
  const d1 = new Date(ts1);
  const d2 = new Date(ts2);
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

function resetDailyTokensIfNeeded(state) {
  const now = Date.now();
  if (!state.tokenUsage.lastReset || !isSameDay(state.tokenUsage.lastReset, now)) {
    state.tokenUsage.today = 0;
    state.tokenUsage.lastReset = now;
    log('info', 'Daily token counter reset');
  }
  return state;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Call MCP signer tool locally via child process
// In production, this would communicate with the MCP signer via stdio
// For now, we directly call the signer logic to avoid stdio complexity
async function callMcpTool(toolName, toolArgs) {
  const nacl = require('tweetnacl');
  const bs58 = require('bs58');
  const { v4: uuidv4 } = require('uuid');
  const crypto = require('crypto');

  if (toolName === 'sign_request') {
    const { action, pubkey, body } = toolArgs;
    const timestamp = Date.now().toString();
    const nonce = uuidv4();

    const bodyHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');
    const canonical = `action=${action}|publicKey=${pubkey}|timestamp=${timestamp}|nonce=${nonce}|bodyHash=${bodyHash}`;

    // ⚠️  Private key read here — NEVER returned or logged
    const privateKeyBase58 = process.env.AGENT_PRIVATE_KEY;
    if (!privateKeyBase58) throw new Error('AGENT_PRIVATE_KEY not set');

    const privateKeyBytes = bs58.decode(privateKeyBase58);
    const keyPair = privateKeyBytes.length === 32
      ? nacl.sign.keyPair.fromSeed(privateKeyBytes)
      : nacl.sign.keyPair.fromSecretKey(privateKeyBytes);

    const messageBytes = Buffer.from(canonical, 'utf8');
    const signatureBytes = nacl.sign.detached(messageBytes, keyPair.secretKey);
    const signature = bs58.encode(signatureBytes);

    return { signature, timestamp, nonce };
  }

  if (toolName === 'get_pubkey') {
    return { pubkey: process.env.AGENT_PUBKEY };
  }

  if (toolName === 'generate_idempotency_key') {
    return { key: uuidv4() };
  }

  if (toolName === 'get_mode') {
    return { mode: process.env.MODE || 'subscription' };
  }

  throw new Error(`Unknown MCP tool: ${toolName}`);
}

async function runConversation(anthropic, systemPrompt, initialMessage, maxTurns) {
  const messages = [{ role: 'user', content: initialMessage }];
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

  const tools = [
    {
      name: 'sign_request',
      description: 'Sign an AgentLink API request. Returns signature, timestamp, nonce only.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          pubkey: { type: 'string' },
          body: { type: 'object' }
        },
        required: ['action', 'pubkey', 'body']
      }
    },
    {
      name: 'get_pubkey',
      description: 'Get agent public key (safe — public only)',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'generate_idempotency_key',
      description: 'Generate a fresh UUID v4 idempotency key',
      input_schema: { type: 'object', properties: {} }
    },
    {
      name: 'get_mode',
      description: 'Get current runtime mode',
      input_schema: { type: 'object', properties: {} }
    }
  ];

  let turns = 0;

  while (turns < maxTurns) {
    turns++;
    let response;

    // Retry logic for API errors
    let retries = 0;
    while (retries < 3) {
      try {
        response = await anthropic.messages.create({
          model,
          max_tokens: 8192,
          system: systemPrompt,
          messages,
          tools
        });
        break;
      } catch (err) {
        if (err.status === 429) {
          log('warn', 'Rate limit hit — waiting 60s before retry');
          await sleep(60000);
          retries++;
        } else if (err.status >= 500) {
          log('warn', `Server error ${err.status} — waiting 30s (attempt ${retries + 1}/3)`);
          await sleep(30000);
          retries++;
        } else {
          throw err;
        }
      }
    }

    if (!response) throw new Error('API call failed after retries');

    // Handle stop reasons
    if (response.stop_reason === 'end_turn') {
      log('info', 'Assistant signaled completion');
      return { completed: true, messages, turns };
    }

    // Process content blocks
    const assistantContent = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    const toolUseBlocks = assistantContent.filter((b) => b.type === 'tool_use');

    if (toolUseBlocks.length === 0) {
      // No more tool calls — conversation complete
      return { completed: true, messages, turns };
    }

    // Execute tool calls and collect results
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      try {
        const result = await callMcpTool(toolUse.name, toolUse.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result)
        });
      } catch (err) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: `Error: ${err.message}`,
          is_error: true
        });
      }
    }

    messages.push({ role: 'user', content: toolResults });
  }

  // Hit max turns
  log('warn', `Hit max turns (${maxTurns}) — saving checkpoint`);
  return { completed: false, messages, turns };
}

async function run() {
  // ⚠️  API key used here only — NEVER passed to Claude
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey.startsWith('sk-ant-your')) {
    console.error('❌ ANTHROPIC_API_KEY not set or is placeholder in .env');
    console.error('   Get your key from: console.anthropic.com/settings/keys');
    console.error('   Set in .env: ANTHROPIC_API_KEY=sk-ant-...');
    process.exit(1);
  }

  const { default: Anthropic } = require('@anthropic-ai/sdk');
  // ⚠️  Key used to init client — NEVER appears in prompts or logs
  const anthropic = new Anthropic({ apiKey });

  const maxTurns = parseInt(process.env.MAX_TURNS || '20', 10);
  const dailyBudget = parseInt(process.env.DAILY_TOKEN_BUDGET || '100000', 10);

  const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');
  const agentSkillContent = fs.readFileSync(AGENT_SKILL_PATH, 'utf8');
  const systemPrompt = `${skillContent}\n\n---\n\n${agentSkillContent}`;

  log('info', 'Starting API mode executor');
  log('info', `Model: ${process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5'}`);

  let state = readState();
  state = resetDailyTokensIfNeeded(state);

  // Check daily token budget
  const budgetUsedPct = (state.tokenUsage.today / dailyBudget) * 100;
  if (budgetUsedPct >= 90) {
    log('warn', `Daily token budget reached (${budgetUsedPct.toFixed(1)}%) — resuming tomorrow`);
    writeState(state);
    process.exit(0);
  }

  log('info', `Token budget: ${state.tokenUsage.today}/${dailyBudget} used today`);

  const initialMessage = 'Begin your heartbeat cycle. Read state.json, check for in-progress jobs to resume, then poll for new jobs.';

  try {
    const result = await runConversation(anthropic, systemPrompt, initialMessage, maxTurns);

    state = readState();
    state = resetDailyTokensIfNeeded(state);
    state.lastHeartbeat = Date.now();

    log('info', `Run complete. Turns: ${result.turns}. Completed: ${result.completed}`);

    writeState(state);

  } catch (err) {
    log('error', `API executor error: ${err.message}`);

    state = readState();
    writeState(state);

    if (err.status === 400 && err.message.includes('context')) {
      log('warn', 'Context limit hit — conversation history may need summarization');
    }

    process.exit(0); // Exit cleanly — cron will retry
  }
}

module.exports = { run };
