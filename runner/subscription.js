/**
 * AgentLink Runner — Subscription Mode Executor
 *
 * Uses the Claude Code CLI (`claude` command) with the user's
 * Claude subscription. Free but subject to usage limits.
 *
 * ⚠️  ANTHROPIC_API_KEY is NOT used or read in this file.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '../state.json');
const SKILL_PATH = path.join(__dirname, '../SKILL.md');

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

function updateState(patch) {
  const state = readState();
  Object.assign(state, patch);
  writeState(state);
}

function log(level, message) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level.toUpperCase()}] ${message}`);
}

function run() {
  const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

  log('info', 'Starting subscription mode executor');
  log('info', 'Using Claude Code CLI (claude command)');

  // Escape the skill content for shell usage
  const escapedSkill = skillContent
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$');

  try {
    const result = execSync(
      `claude --print "${escapedSkill}"`,
      {
        timeout: 300000, // 5 minutes
        encoding: 'utf8',
        cwd: path.join(__dirname, '..'),
        env: { ...process.env }
      }
    );

    log('success', 'Claude Code run completed successfully');
    if (result) {
      console.log(result.toString());
    }

    updateState({ limitHitAt: null });
    log('info', 'Cleared limitHitAt — ready for next run');

  } catch (error) {
    const output = (error.stdout || '').toString();
    const stderr = (error.stderr || '').toString();
    const combined = output + stderr;

    // Check for rate/usage limit signals
    const isLimitHit = (
      combined.toLowerCase().includes('rate limit') ||
      combined.toLowerCase().includes('usage limit') ||
      combined.toLowerCase().includes('exceeded') ||
      combined.toLowerCase().includes('quota')
    );

    if (isLimitHit) {
      log('warn', 'Subscription limit hit — will retry in 1 hour');
      updateState({ limitHitAt: Date.now() });
      process.exit(0); // Clean exit — cron will retry
      return;
    }

    // Timeout
    if (error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT') {
      log('warn', 'Execution timed out — saving checkpoint');
      const state = readState();
      // Mark any in-progress jobs with timeout checkpoint
      for (const [jobId, job] of Object.entries(state.jobs)) {
        if (job.status === 'IN_PROGRESS') {
          state.jobs[jobId] = {
            ...job,
            checkpoint: 'timeout — resume from last known step',
            timedOutAt: Date.now()
          };
        }
      }
      writeState(state);
      process.exit(0);
      return;
    }

    // Unknown error
    log('error', `Unexpected error: ${error.message}`);
    if (output) log('error', `stdout: ${output.slice(0, 500)}`);
    if (stderr) log('error', `stderr: ${stderr.slice(0, 500)}`);
    process.exit(1);
  }
}

module.exports = { run };
