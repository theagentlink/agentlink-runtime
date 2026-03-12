/**
 * AgentLink Runner — Subscription Mode Executor
 *
 * Uses the Claude Code CLI (`claude` command) with the user's
 * Claude subscription. Free but subject to usage limits.
 *
 * ⚠️  ANTHROPIC_API_KEY is NOT used or read in this file.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '../state.json');
const SKILL_PATH = path.join(__dirname, '../SKILL.md');
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

function updateState(patch) {
  const state = readState();
  Object.assign(state, patch);
  writeState(state);
}

function log(level, message) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_PATH, line + '\n');
}

function handleStreamEvent(event) {
  try {
    const ev = JSON.parse(event);

    // Print assistant text content live
    if (ev.type === 'assistant') {
      const content = ev.message?.content || [];
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          process.stdout.write(block.text);
          fs.appendFileSync(LOG_PATH, block.text);
        } else if (block.type === 'tool_use') {
          const line = `\n[TOOL] ${block.name}`;
          process.stdout.write(line + '\n');
          fs.appendFileSync(LOG_PATH, line + '\n');
        }
      }
    }

    // Partial streaming text
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      process.stdout.write(ev.delta.text);
      fs.appendFileSync(LOG_PATH, ev.delta.text);
    }

  } catch {
    // Not JSON — print as-is
    if (event.trim()) {
      process.stdout.write(event + '\n');
      fs.appendFileSync(LOG_PATH, event + '\n');
    }
  }
}

function run() {
  const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

  log('info', 'Starting subscription mode executor');
  log('info', 'Using Claude Code CLI (claude command)');

  return new Promise((resolve) => {
    const child = spawn(
      'claude',
      [
        '--print',
        '--output-format', 'stream-json',
        '--include-partial-messages',
        '--dangerously-skip-permissions',
        skillContent
      ],
      {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, ANTHROPIC_API_KEY: undefined },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let stderr = '';
    let buffer = '';

    // Timeout after 59 minutes
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, 3540000);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line
      for (const line of lines) {
        handleStreamEvent(line);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);

      // Flush any remaining buffer
      if (buffer.trim()) handleStreamEvent(buffer);

      process.stdout.write('\n');

      const combined = stderr;

      if (signal === 'SIGTERM') {
        log('warn', 'Execution timed out — saving checkpoint');
        const state = readState();
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
        resolve(0);
        return;
      }

      const isLimitHit = (
        combined.toLowerCase().includes('rate limit') ||
        combined.toLowerCase().includes('usage limit') ||
        combined.toLowerCase().includes('exceeded') ||
        combined.toLowerCase().includes('quota')
      );

      if (isLimitHit) {
        log('warn', 'Subscription limit hit — will retry in 1 hour');
        updateState({ limitHitAt: Date.now() });
        resolve(0);
        return;
      }

      if (code === 0) {
        log('success', 'Claude Code run completed successfully');
        updateState({ limitHitAt: null });
        log('info', 'Cleared limitHitAt — ready for next run');
        resolve(0);
        return;
      }

      log('error', `Unexpected error: exit code ${code}`);
      if (stderr) log('error', `stderr: ${stderr.slice(0, 500)}`);
      resolve(1);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      log('error', `Failed to start claude: ${err.message}`);
      resolve(1);
    });
  });
}

module.exports = { run };
