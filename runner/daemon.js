#!/usr/bin/env node
/**
 * AgentLink Runtime — Daemon Mode
 *
 * Runs as a persistent process, looping every HEARTBEAT_INTERVAL_MS (default 30 min).
 * Handles all three modes: openai-api, claude-api, claude-subscription.
 *
 * Features:
 *  - Auto-resumes IN_PROGRESS jobs on every cycle
 *  - Subscription mode: respects limitHitAt cooldown, sleeps exact remaining time
 *  - API modes: sleeps until midnight when daily token budget is reached
 *  - Graceful shutdown: waits for current run to finish before exiting
 *  - Crash recovery: logs error, saves state, continues looping
 *
 * Usage:
 *   node runner/daemon.js               (direct)
 *   pm2 start pm2.config.js             (recommended for production)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');

// ─── Paths ───────────────────────────────────────────────────────────────────

const STATE_PATH       = path.join(__dirname, '../state.json');
const LOG_PATH         = path.join(__dirname, '../logs/daemon.log');
const AGENT_SKILL_PATH = path.join(__dirname, '../AGENT_SKILL.md');

// ─── Config ──────────────────────────────────────────────────────────────────

const RAW_MODE               = process.env.MODE || 'claude-subscription';
const MODE                   = RAW_MODE === 'subscription' ? 'claude-subscription' : RAW_MODE;
const HEARTBEAT_INTERVAL_MS  = parseInt(process.env.HEARTBEAT_INTERVAL_MS || String(30 * 60 * 1000), 10);
const SUBSCRIPTION_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// ─── State ───────────────────────────────────────────────────────────────────

let shuttingDown  = false;
let runInProgress = false;
let sleepTimer    = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureLogsDir() {
  const logsDir = path.join(__dirname, '../logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
}

function log(level, message) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] [daemon] ${message}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch { /* log dir missing */ }
}

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

function truncatePubkey(pubkey) {
  if (!pubkey || pubkey.length < 8) return pubkey || 'NOT_SET';
  return `${pubkey.slice(0, 4)}...${pubkey.slice(-4)}`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    if (ms <= 0) { resolve(); return; }
    sleepTimer = setTimeout(() => { sleepTimer = null; resolve(); }, ms);
  });
}

function cancelSleep() {
  if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
}

function msUntilMidnight() {
  const now      = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime() - now.getTime();
}

function formatDuration(ms) {
  if (ms < 60000)   return `${Math.round(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

// ─── Pre-run checks ───────────────────────────────────────────────────────────

/**
 * Returns { skip: true, sleepMs } if the cycle should be skipped/delayed.
 * Returns { skip: false } if it's safe to run.
 */
async function preRunChecks() {
  const state = readState();

  // ── Subscription cooldown ────────────────────────────────────────────────
  if (MODE === 'claude-subscription' && state.limitHitAt) {
    const elapsed   = Date.now() - state.limitHitAt;
    const remaining = SUBSCRIPTION_COOLDOWN_MS - elapsed;

    if (remaining > 0) {
      log('warn', `Subscription limit cooldown — ${formatDuration(remaining)} remaining, sleeping...`);
      await sleep(remaining);
      if (shuttingDown) return { skip: true };

      // Clear limitHitAt now that cooldown is over
      const s = readState();
      s.limitHitAt = null;
      writeState(s);
      log('info', 'Subscription cooldown expired — resuming');
    } else {
      const s = readState();
      s.limitHitAt = null;
      writeState(s);
      log('info', 'Subscription cooldown expired — resuming');
    }
  }

  // ── API mode daily token budget ──────────────────────────────────────────
  if (MODE !== 'claude-subscription') {
    const dailyBudget = parseInt(process.env.DAILY_TOKEN_BUDGET || '100000', 10);
    const todayTokens = state.tokenUsage?.today || 0;

    if (todayTokens >= dailyBudget * 0.9) {
      const waitMs = msUntilMidnight();
      log('warn', `Daily token budget reached (${todayTokens}/${dailyBudget}) — sleeping ${formatDuration(waitMs)} until midnight reset`);
      await sleep(waitMs);
      if (shuttingDown) return { skip: true };
      log('info', 'Midnight passed — daily token counter will reset on next run');
    }
  }

  return { skip: false };
}

// ─── Log in-progress jobs ─────────────────────────────────────────────────────

function logJobStatus() {
  const state = readState();
  const jobs  = Object.values(state.jobs || {});

  const inProgress = jobs.filter(j => j.status === 'IN_PROGRESS');
  const bidding    = jobs.filter(j => j.status === 'BIDDING');
  const delivered  = jobs.filter(j => j.status === 'DELIVERED');

  if (inProgress.length > 0) {
    log('info', `Resuming ${inProgress.length} IN_PROGRESS job(s):`);
    for (const job of inProgress) {
      log('info', `  → ${job.jobId} | step: ${job.step || '?'} | checkpoint: ${job.checkpoint?.slice(0, 80) || '?'}`);
    }
  }
  if (bidding.length > 0) {
    log('info', `${bidding.length} job(s) awaiting bid acceptance`);
  }
  if (delivered.length > 0) {
    log('info', `${delivered.length} job(s) delivered, awaiting payment`);
  }
  if (inProgress.length === 0 && bidding.length === 0 && delivered.length === 0) {
    log('info', 'No active jobs — scanning for new work');
  }
}

// ─── Single cycle ─────────────────────────────────────────────────────────────

async function runCycle() {
  const { skip } = await preRunChecks();
  if (skip || shuttingDown) return;

  logJobStatus();

  try {
    if (MODE === 'openai-api') {
      const { run } = require('./openai.js');
      await run();
    } else if (MODE === 'claude-api') {
      const { run } = require('./api.js');
      await run();
    } else if (MODE === 'claude-subscription') {
      const { run } = require('./subscription.js');
      await run();
    }
  } catch (err) {
    log('error', `Executor threw: ${err.message}`);

    // Save error context to all IN_PROGRESS jobs so LLM can resume cleanly
    const state = readState();
    let dirty = false;
    for (const [jobId, job] of Object.entries(state.jobs || {})) {
      if (job.status === 'IN_PROGRESS') {
        state.jobs[jobId] = {
          ...job,
          checkpoint: job.checkpoint
            ? `${job.checkpoint} [daemon error — resume from this step]`
            : 'daemon error — re-read job details and resume',
          lastErrorAt: Date.now(),
        };
        dirty = true;
      }
    }
    if (dirty) writeState(state);

    // Don't crash the daemon — log and continue to next cycle
    log('warn', 'Executor error handled — daemon will retry on next cycle');
  }
}

// ─── Main daemon loop ─────────────────────────────────────────────────────────

async function daemonLoop() {
  while (!shuttingDown) {
    runInProgress = true;
    const cycleStart = Date.now();

    log('info', '─────────────────────────────────────────');
    log('info', `Cycle starting at ${new Date().toISOString()}`);

    await runCycle();

    runInProgress = false;

    if (shuttingDown) break;

    const elapsed = Date.now() - cycleStart;
    const waitMs  = Math.max(0, HEARTBEAT_INTERVAL_MS - elapsed);

    log('info', `Cycle done in ${formatDuration(elapsed)}. Next cycle in ${formatDuration(waitMs)}`);
    log('info', '─────────────────────────────────────────');

    await sleep(waitMs);
  }

  log('info', 'Daemon stopped cleanly.');
  process.exit(0);
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log('info', `${signal} received — shutting down...`);
  cancelSleep(); // wake from sleep immediately

  if (!runInProgress) {
    log('info', 'No run in progress — exiting now.');
    process.exit(0);
  } else {
    log('info', 'Waiting for current run to finish before exit...');
    // daemonLoop will exit naturally when the while condition is checked
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  log('error', `Uncaught exception: ${err.message}`);
  log('error', err.stack || '(no stack)');
  // PM2 will restart the process
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
  process.exit(1);
});

// ─── Startup validation ───────────────────────────────────────────────────────

ensureLogsDir();

if (!fs.existsSync(AGENT_SKILL_PATH)) {
  console.error('❌ AGENT_SKILL.md not found.');
  console.error('   Download from: theagentlink.xyz/dashboard/agents/{id}');
  process.exit(1);
}

const agentSkillContent = fs.readFileSync(AGENT_SKILL_PATH, 'utf8');
if (agentSkillContent.includes('PLACEHOLDER')) {
  console.error('❌ AGENT_SKILL.md is still a placeholder. Download your version from the dashboard.');
  process.exit(1);
}

if (!process.env.AGENT_PUBKEY || process.env.AGENT_PUBKEY === 'your_agent_public_key_here') {
  console.error('❌ AGENT_PUBKEY not set in .env');
  process.exit(1);
}

if (!process.env.AGENT_PRIVATE_KEY || process.env.AGENT_PRIVATE_KEY === 'your_agent_private_key_base58_here') {
  console.error('❌ AGENT_PRIVATE_KEY not set in .env');
  process.exit(1);
}

if (MODE === 'openai-api' && (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.startsWith('sk-your'))) {
  console.error('❌ OPENAI_API_KEY not set in .env (required for openai-api mode)');
  process.exit(1);
}

if (MODE === 'claude-api' && (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.startsWith('sk-ant-your'))) {
  console.error('❌ ANTHROPIC_API_KEY not set in .env (required for claude-api mode)');
  process.exit(1);
}

// ─── Start ────────────────────────────────────────────────────────────────────

console.log('');
console.log('╔══════════════════════════════════════╗');
console.log('║      AgentLink Daemon Starting       ║');
console.log('╚══════════════════════════════════════╝');
console.log(`Mode:     ${MODE}`);
console.log(`Agent:    ${truncatePubkey(process.env.AGENT_PUBKEY)}`);
console.log(`Oracle:   ${process.env.AGENTLINK_ORACLE_URL || 'NOT_SET'}`);
console.log(`Interval: ${formatDuration(HEARTBEAT_INTERVAL_MS)}`);
console.log(`Logs:     logs/daemon.log`);
console.log('');

daemonLoop().catch((err) => {
  log('error', `Fatal: ${err.message}`);
  process.exit(1);
});
