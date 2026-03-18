/**
 * AgentLink Runner — OpenAI API Mode Executor
 *
 * Uses the OpenAI API for true 24/7 operation.
 * Reads OPENAI_API_KEY from .env — key NEVER enters the model's context.
 *
 * ⚠️  SECURITY: API key is used to initialize the client only.
 *     It is NEVER passed to the model or logged anywhere.
 */

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '../state.json');
const SKILL_PATH = path.join(__dirname, '../SKILL.md');
const AGENT_SKILL_PATH = path.join(__dirname, '../AGENT_SKILL.md');
const MY_AGENT_PATH = path.join(__dirname, '../MY_AGENT.md');
const LOG_PATH = path.join(__dirname, '../resume.log');

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
  const line = `[${ts}] [${level.toUpperCase()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
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
  if (!state.tokenUsage) {
    state.tokenUsage = { today: 0, total: 0, lastReset: now };
  }
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

function validateUuid(value, name) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`Invalid ${name}: "${value}" is not a valid UUID (expected format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx). Read the exact ID from state.json or the API response before signing.`);
  }
}

function signFields(fields) {
  const nacl = require('tweetnacl');
  const bs58 = require('bs58');
  const { v4: uuidv4 } = require('uuid');

  const timestamp = Date.now();
  const nonce = uuidv4();

  const parts = { ...fields, timestamp };
  const canonical = Object.entries(parts)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('|');

  const privateKeyBase58 = process.env.AGENT_PRIVATE_KEY;
  if (!privateKeyBase58) throw new Error('AGENT_PRIVATE_KEY not set');

  const privateKeyBytes = bs58.decode(privateKeyBase58);
  const keyPair = privateKeyBytes.length === 32
    ? nacl.sign.keyPair.fromSeed(privateKeyBytes)
    : nacl.sign.keyPair.fromSecretKey(privateKeyBytes);

  const signatureBytes = nacl.sign.detached(Buffer.from(canonical, 'utf8'), keyPair.secretKey);
  log('info', `Signed: ${canonical}`);
  return { signature: bs58.encode(signatureBytes), timestamp, nonce, workerPubkey: fields.worker };
}

async function callTool(toolName, toolArgs) {
  const { v4: uuidv4 } = require('uuid');
  const workerPubkey = process.env.AGENT_PUBKEY;

  // Action-specific signing tools — each knows exactly which fields the Oracle requires
  if (toolName === 'sign_bid') {
    const { jobId, amount } = toolArgs;
    validateUuid(jobId, 'jobId');
    return signFields({ action: 'bid', worker: workerPubkey, jobId, amount: Number(amount) });
  }

  if (toolName === 'sign_acknowledge_job') {
    const { jobId } = toolArgs;
    validateUuid(jobId, 'jobId');
    return signFields({ action: 'acknowledge_job', worker: workerPubkey, jobId });
  }

  if (toolName === 'sign_execution_event') {
    const { jobId, runId, state } = toolArgs;
    validateUuid(jobId, 'jobId');
    return signFields({ action: 'execution_event', worker: workerPubkey, jobId, runId, state });
  }

  if (toolName === 'sign_deliver') {
    const { jobId, url } = toolArgs;
    validateUuid(jobId, 'jobId');
    return signFields({ action: 'deliver', worker: workerPubkey, jobId, url });
  }

  if (toolName === 'sign_request_delivery_repo') {
    const { jobId } = toolArgs;
    validateUuid(jobId, 'jobId');
    return signFields({ action: 'request_delivery_repo', worker: workerPubkey, jobId });
  }

  if (toolName === 'upload_to_repo') {
    const https = require('node:https');
    const { worker_url, files, commit_message = 'Deliver work' } = toolArgs;

    // Parse: https://x-access-token:{TOKEN}@github.com/{ORG}/{REPO}.git
    const match = worker_url.match(/https:\/\/x-access-token:([^@]+)@github\.com\/([^/]+)\/([^/.]+)/);
    if (!match) throw new Error('Invalid worker_url format — expected https://x-access-token:{token}@github.com/{org}/{repo}');
    const [, token, org, repo] = match;

    const results = [];
    for (const file of files) {
      const content = Buffer.from(file.content, 'utf8').toString('base64');
      const payload = JSON.stringify({ message: commit_message, content });
      const result = await new Promise((resolve) => {
        const options = {
          hostname: 'api.github.com',
          path: `/repos/${org}/${repo}/contents/${file.path}`,
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'agentlink-runtime/1.0',
            'Content-Length': Buffer.byteLength(payload)
          }
        };
        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
            catch { resolve({ status: res.statusCode, body: data }); }
          });
        });
        req.on('error', (err) => resolve({ error: err.message }));
        req.write(payload);
        req.end();
      });
      results.push({ path: file.path, status: result.status });
      log('info', `upload_to_repo: ${file.path} → HTTP ${result.status}`);
    }

    return {
      repo_url: `https://github.com/${org}/${repo}`,
      files_uploaded: results.filter((r) => r.status === 201 || r.status === 200).length,
      results
    };
  }

  if (toolName === 'agent_done') {
    log('info', `agent_done: ${toolArgs.reason}`);
    return { ok: true, done: true };
  }

  if (toolName === 'write_delivery_file') {
    const { jobId, filename, content } = toolArgs;
    validateUuid(jobId, 'jobId');
    const dir = path.join(__dirname, '../deliveries', jobId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content, 'utf8');
    log('info', `write_delivery_file: deliveries/${jobId}/${filename} (${content.length} chars)`);
    return { ok: true, path: `deliveries/${jobId}/${filename}` };
  }

  if (toolName === 'push_delivery_folder') {
    const https = require('node:https');
    const { jobId, worker_url, commit_message = 'Deliver work' } = toolArgs;
    validateUuid(jobId, 'jobId');

    const dir = path.join(__dirname, '../deliveries', jobId);
    if (!fs.existsSync(dir)) {
      throw new Error(`No delivery folder found at deliveries/${jobId}. Use write_delivery_file first.`);
    }

    const match = worker_url.match(/https:\/\/x-access-token:([^@]+)@github\.com\/([^/]+)\/([^/.]+)/);
    if (!match) throw new Error('Invalid worker_url format');
    const [, token, org, repo] = match;

    // Collect all files recursively
    const allFiles = [];
    function readDir(dirPath, base = '') {
      for (const entry of fs.readdirSync(dirPath)) {
        const full = path.join(dirPath, entry);
        const rel = base ? `${base}/${entry}` : entry;
        if (fs.statSync(full).isDirectory()) {
          readDir(full, rel);
        } else {
          allFiles.push({ path: rel, content: fs.readFileSync(full, 'utf8') });
        }
      }
    }
    readDir(dir);

    // Helper: make a GitHub API request
    const githubRequest = (method, filePath, body) => new Promise((resolve) => {
      const payload = JSON.stringify(body);
      const options = {
        hostname: 'api.github.com',
        path: `/repos/${org}/${repo}/contents/${filePath}`,
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'agentlink-runtime/1.0',
          'Content-Length': Buffer.byteLength(payload)
        }
      };
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', (err) => resolve({ error: err.message }));
      req.write(payload);
      req.end();
    });

    const results = [];
    for (const file of allFiles) {
      const content = Buffer.from(file.content, 'utf8').toString('base64');

      // Fetch existing file SHA (needed for updates)
      const getResult = await new Promise((resolve) => {
        const options = {
          hostname: 'api.github.com',
          path: `/repos/${org}/${repo}/contents/${file.path}`,
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'agentlink-runtime/1.0'
          }
        };
        const req = https.request(options, (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
            catch { resolve({ status: res.statusCode, body: data }); }
          });
        });
        req.on('error', (err) => resolve({ error: err.message }));
        req.end();
      });

      const putBody = { message: commit_message, content };
      if (getResult.status === 200 && getResult.body?.sha) {
        putBody.sha = getResult.body.sha; // required for updates
      }

      const result = await githubRequest('PUT', file.path, putBody);
      results.push({ path: file.path, status: result.status });
      log('info', `push_delivery_folder: ${file.path} → HTTP ${result.status}`);
    }

    return {
      repo_url: `https://github.com/${org}/${repo}`,
      files_pushed: results.filter((r) => r.status === 201 || r.status === 200).length,
      total_files: allFiles.length,
      results
    };
  }

  if (toolName === 'get_pubkey') {
    return { pubkey: workerPubkey };
  }

  if (toolName === 'generate_idempotency_key') {
    return { key: uuidv4() };
  }

  if (toolName === 'get_mode') {
    return {
      mode: process.env.MODE || 'openai-api',
      oracleUrl: process.env.AGENTLINK_ORACLE_URL || 'http://localhost:3000',
      deliveryUrl: process.env.AGENTLINK_DELIVERY_URL || 'http://localhost:8001',
    };
  }

  if (toolName === 'read_state') {
    try {
      return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
      return { jobs: {}, lastHeartbeat: null, limitHitAt: null, resumeAttempts: 0 };
    }
  }

  if (toolName === 'write_state') {
    const incoming = toolArgs.state ?? toolArgs;
    if (typeof incoming !== 'object' || incoming === null) {
      return { ok: false, error: 'Invalid state: must be an object' };
    }
    // Merge with existing state to prevent model from dropping required fields
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch {}
    const merged = {
      ...existing,
      ...incoming,
      tokenUsage: { ...(existing.tokenUsage || {}), ...(incoming.tokenUsage || {}) }
    };
    fs.writeFileSync(STATE_PATH, JSON.stringify(merged, null, 2));
    return { ok: true };
  }

  if (toolName === 'http_get') {
    const https = require('node:https');
    const http = require('node:http');
    const { url, params } = toolArgs;
    const fullUrl = new URL(url);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        fullUrl.searchParams.set(k, v);
      }
    }
    return new Promise((resolve) => {
      const lib = fullUrl.protocol === 'https:' ? https : http;
      lib.get(fullUrl.toString(), (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }).on('error', (err) => resolve({ error: err.message }));
    });
  }

  if (toolName === 'http_post') {
    const https = require('node:https');
    const http = require('node:http');
    const { url, body, headers = {} } = toolArgs;
    const { v4: uuidv4 } = require('uuid');
    const payload = JSON.stringify(body);
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Idempotency-Key': headers['Idempotency-Key'] || uuidv4(),
        ...headers
      }
    };
    return new Promise((resolve) => {
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      });
      req.on('error', (err) => resolve({ error: err.message }));
      req.write(payload);
      req.end();
    });
  }

  throw new Error(`Unknown tool: ${toolName}`);
}

async function runConversation(openai, systemPrompt, initialMessage, maxTurns) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o';

  const tools = [
    {
      type: 'function',
      function: {
        name: 'sign_bid',
        description: 'Sign a bid request. Returns { signature, timestamp, nonce, workerPubkey } — use ALL returned values in the POST body.',
        parameters: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: 'Job ID to bid on' },
            amount: { type: 'number', description: 'Bid amount in SOL' }
          },
          required: ['jobId', 'amount']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'sign_acknowledge_job',
        description: 'Sign a job acknowledgment. Returns { signature, timestamp, nonce, workerPubkey } — use ALL returned values in the POST body.',
        parameters: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: 'Job ID to acknowledge' }
          },
          required: ['jobId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'sign_execution_event',
        description: 'Sign an execution event. Returns { signature, timestamp, nonce, workerPubkey } — use ALL returned values in the POST body.',
        parameters: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: 'Job ID' },
            runId: { type: 'string', description: 'Run ID (e.g. run-{first8charsOfJobId})' },
            state: { type: 'string', enum: ['STARTED', 'PROGRESS', 'SUCCEEDED'], description: 'Execution state' }
          },
          required: ['jobId', 'runId', 'state']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'sign_deliver',
        description: 'Sign a delivery. Returns { signature, timestamp, nonce, workerPubkey } — use ALL returned values in the POST body.',
        parameters: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: 'Job ID' },
            url: { type: 'string', description: 'Delivery URL (GitHub repo or hosted URL)' }
          },
          required: ['jobId', 'url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'sign_request_delivery_repo',
        description: 'Sign a delivery repo access request. Returns { signature, timestamp, nonce, workerPubkey } — use ALL returned values in the POST body.',
        parameters: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: 'Job ID' }
          },
          required: ['jobId']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'upload_to_repo',
        description: 'Upload files to the delivery GitHub repo using the worker_url from repo/worker-access. Returns { repo_url, files_uploaded }.',
        parameters: {
          type: 'object',
          properties: {
            worker_url: { type: 'string', description: 'Authenticated git URL from repo/worker-access response (https://x-access-token:{token}@github.com/...)' },
            files: {
              type: 'array',
              description: 'Files to upload',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'File path in repo (e.g. delivery.md)' },
                  content: { type: 'string', description: 'File content as plain text' }
                },
                required: ['path', 'content']
              }
            },
            commit_message: { type: 'string', description: 'Git commit message' }
          },
          required: ['worker_url', 'files']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_delivery_file',
        description: 'Write a file to the local deliveries/{jobId}/ folder. Call this for each file you want to deliver (the actual work, README, etc.).',
        parameters: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: 'Job ID (valid UUID)' },
            filename: { type: 'string', description: 'File name (e.g. post.md, README.md, result.txt)' },
            content: { type: 'string', description: 'Full file content as plain text' }
          },
          required: ['jobId', 'filename', 'content']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'agent_done',
        description: 'Call this ONLY when you have truly finished all work for this cycle: all IN_PROGRESS jobs are delivered, all BIDDING/DELIVERED jobs are checked, and no new jobs need action. Do NOT call this mid-task. Never call this while a job is still executing.',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: 'Why the cycle is complete (e.g. "No jobs to execute", "All jobs delivered")' }
          },
          required: ['reason']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'push_delivery_folder',
        description: 'Push ALL files from deliveries/{jobId}/ to the GitHub delivery repo. Call write_delivery_file for every file first, then call this once to push everything.',
        parameters: {
          type: 'object',
          properties: {
            jobId: { type: 'string', description: 'Job ID (valid UUID)' },
            worker_url: { type: 'string', description: 'Authenticated git URL from request-delivery-repo response' },
            commit_message: { type: 'string', description: 'Git commit message' }
          },
          required: ['jobId', 'worker_url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_pubkey',
        description: 'Get the agent public key.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'generate_idempotency_key',
        description: 'Generate a fresh UUID v4 for Idempotency-Key header.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_mode',
        description: 'Get the current runtime mode, oracleUrl, and deliveryUrl.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_state',
        description: 'Read the current state.json (in-progress jobs, last heartbeat, etc).',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_state',
        description: 'Write updated state to state.json.',
        parameters: {
          type: 'object',
          properties: {
            state: { type: 'object', description: 'Full state object to persist' }
          },
          required: ['state']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'http_get',
        description: 'Make a GET request to the AgentLink Oracle API.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full URL to request' },
            params: { type: 'object', description: 'Optional query parameters' }
          },
          required: ['url']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'http_post',
        description: 'Make a POST request to the AgentLink Oracle API.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Full URL to request' },
            body: { type: 'object', description: 'JSON body to send' },
            headers: { type: 'object', description: 'Optional extra headers (e.g. Idempotency-Key)' }
          },
          required: ['url', 'body']
        }
      }
    }
  ];

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: initialMessage }
  ];

  let turns = 0;

  while (turns < maxTurns) {
    turns++;
    let response;

    let retries = 0;
    while (retries < 3) {
      try {
        response = await openai.chat.completions.create({
          model,
          max_tokens: 8192,
          messages,
          tools,
          tool_choice: 'auto'
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

    const choice = response.choices[0];
    const message = choice.message;

    messages.push(message);

    // Print assistant text live
    if (message.content) {
      process.stdout.write(message.content + '\n');
      fs.appendFileSync(LOG_PATH, message.content + '\n');
    }

    // Check if agent_done was called
    const agentDoneCall = message.tool_calls?.find(t => t.function.name === 'agent_done');
    if (agentDoneCall) {
      log('info', 'Assistant signaled completion');
      return { completed: true, messages, turns };
    }

    // If no tool calls at all, nudge model to continue or call agent_done
    if (!message.tool_calls?.length) {
      log('info', 'No tool calls — nudging model to continue or call agent_done');
      messages.push({
        role: 'user',
        content: 'You output text but made no tool calls. If you have deliverable content to save, call write_delivery_file now and continue the job. If all tasks for this cycle are truly complete (nothing left to execute), call agent_done({ reason: "..." }).'
      });
      continue;
    }

    // Execute tool calls
    for (const toolCall of message.tool_calls) {
      let result;
      let args;
      try {
        args = JSON.parse(toolCall.function.arguments);
        log('info', `Tool: ${toolCall.function.name}`);
        result = await callTool(toolCall.function.name, args);
      } catch (err) {
        result = { error: err.message };
      }

      const resultStr = JSON.stringify(result);
      if (toolCall.function.name === 'http_post' || toolCall.function.name === 'http_get') {
        const reqUrl = (args && args.url) || '';
        const reqBody = args && args.body ? JSON.stringify(args.body).slice(0, 300) : '';
        log('info', `${toolCall.function.name} ${reqUrl} body=${reqBody} → ${resultStr.slice(0, 300)}`);
      }
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: resultStr
      });
    }
  }

  log('warn', `Hit max turns (${maxTurns}) — saving checkpoint`);
  return { completed: false, messages, turns };
}

async function run() {
  // ⚠️  API key used here only — NEVER passed to the model
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.startsWith('sk-your')) {
    console.error('❌ OPENAI_API_KEY not set or is placeholder in .env');
    console.error('   Get your key from: platform.openai.com/api-keys');
    console.error('   Set in .env: OPENAI_API_KEY=sk-...');
    process.exit(1);
  }

  const { default: OpenAI } = require('openai');
  // ⚠️  Key used to init client — NEVER appears in prompts or logs
  const openai = new OpenAI({ apiKey });

  const maxTurns = parseInt(process.env.MAX_TURNS || '20', 10);
  const dailyBudget = parseInt(process.env.DAILY_TOKEN_BUDGET || '100000', 10);

  const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');
  const agentSkillContent = fs.readFileSync(AGENT_SKILL_PATH, 'utf8');
  const myAgentContent = fs.existsSync(MY_AGENT_PATH) ? fs.readFileSync(MY_AGENT_PATH, 'utf8') : null;
  if (myAgentContent) {
    log('info', 'MY_AGENT.md loaded — custom instructions active');
  } else {
    log('warn', 'No MY_AGENT.md found — copy MY_AGENT.md.example to MY_AGENT.md and edit it to define your agent specialty');
  }
  const systemPrompt = myAgentContent
    ? `${skillContent}\n\n---\n\n${agentSkillContent}\n\n---\n\n${myAgentContent}`
    : `${skillContent}\n\n---\n\n${agentSkillContent}`;

  log('info', 'Starting OpenAI API mode executor');
  log('info', `Model: ${process.env.OPENAI_MODEL || 'gpt-4o'}`);

  let state = readState();
  state = resetDailyTokensIfNeeded(state);

  const budgetUsedPct = (state.tokenUsage.today / dailyBudget) * 100;
  if (budgetUsedPct >= 90) {
    log('warn', `Daily token budget reached (${budgetUsedPct.toFixed(1)}%) — resuming tomorrow`);
    writeState(state);
    return; // daemon handles the sleep; single-run mode exits naturally
  }

  log('info', `Token budget: ${state.tokenUsage.today}/${dailyBudget} used today`);

  const initialMessage = 'Begin your heartbeat cycle. Read state.json, check for in-progress jobs to resume, then poll for new jobs.';

  try {
    const result = await runConversation(openai, systemPrompt, initialMessage, maxTurns);

    state = readState();
    state = resetDailyTokensIfNeeded(state);
    state.lastHeartbeat = Date.now();

    log('info', `Run complete. Turns: ${result.turns}. Completed: ${result.completed}`);
    writeState(state);

  } catch (err) {
    log('error', `OpenAI executor error: ${err.message}`);

    state = readState();
    writeState(state);

    return; // daemon will retry on next cycle; single-run mode exits naturally
  }
}

module.exports = { run };
