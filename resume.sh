#!/bin/bash
# ─── AgentLink Runtime Resume Script ──────────────────
# Cron setup:
#   chmod +x resume.sh
#   crontab -e
#   Add: 0 * * * * /full/path/to/agentlink-runtime/resume.sh
#
# Runs every hour. Resumes incomplete jobs automatically.
# ──────────────────────────────────────────────────────

set -euo pipefail

# Get the directory of this script (handles symlinks)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$SCRIPT_DIR/resume.log"
STATE_FILE="$SCRIPT_DIR/state.json"
SKILL_FILE="$SCRIPT_DIR/AGENT_SKILL.md"
ENV_FILE="$SCRIPT_DIR/.env"

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

log() {
  echo "[$(timestamp)] $1" | tee -a "$LOG_FILE"
}

# ─── Load .env ──────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  log "ERROR: .env file not found at $ENV_FILE"
  log "ERROR: Run: cp $SCRIPT_DIR/.env.example $SCRIPT_DIR/.env"
  exit 1
fi

# Export .env variables (skip comments and empty lines)
set -a
# shellcheck disable=SC1090
source <(grep -v '^#' "$ENV_FILE" | grep -v '^[[:space:]]*$')
set +a

MODE="${MODE:-claude-subscription}"

# ─── Validate based on MODE ─────────────────────────────
if [ "$MODE" = "claude-subscription" ]; then
  if ! command -v claude &>/dev/null; then
    log "ERROR: claude CLI not found. Install: npm install -g @anthropic-ai/claude-code"
    exit 1
  fi
  log "INFO: Mode=claude-subscription, claude CLI found"
elif [ "$MODE" = "claude-api" ]; then
  if [ -z "${ANTHROPIC_API_KEY:-}" ] || [[ "$ANTHROPIC_API_KEY" == sk-ant-your* ]]; then
    log "ERROR: ANTHROPIC_API_KEY not set or is placeholder in .env"
    log "ERROR: Get your key from: console.anthropic.com/settings/keys"
    exit 1
  fi
  log "INFO: Mode=claude-api, Anthropic API key configured"
elif [ "$MODE" = "openai-api" ]; then
  if [ -z "${OPENAI_API_KEY:-}" ] || [[ "$OPENAI_API_KEY" == sk-your* ]]; then
    log "ERROR: OPENAI_API_KEY not set or is placeholder in .env"
    log "ERROR: Get your key from: platform.openai.com/api-keys"
    exit 1
  fi
  log "INFO: Mode=openai-api, OpenAI API key configured"
else
  log "ERROR: Unknown MODE=$MODE. Must be: claude-subscription | claude-api | openai-api"
  exit 1
fi

# ─── Check AGENT_SKILL.md ───────────────────────────────
if [ ! -f "$SKILL_FILE" ]; then
  log "ERROR: AGENT_SKILL.md not found"
  log "ERROR: Download from: theagentlink.xyz/dashboard/agents/{id}"
  exit 1
fi

if grep -q "PLACEHOLDER" "$SKILL_FILE"; then
  log "ERROR: AGENT_SKILL.md is still a placeholder"
  log "ERROR: Download your personalized version from: theagentlink.xyz/dashboard/agents/{id}"
  exit 1
fi

# ─── Check state.json for limit cooldown ────────────────
if [ -f "$STATE_FILE" ]; then
  LIMIT_HIT_AT=$(node -e "
    const s = require('$STATE_FILE');
    console.log(s.limitHitAt || '');
  " 2>/dev/null || echo "")

  if [ -n "$LIMIT_HIT_AT" ] && [ "$LIMIT_HIT_AT" != "null" ]; then
    NOW_MS=$(node -e "console.log(Date.now())" 2>/dev/null)
    ELAPSED_MS=$((NOW_MS - LIMIT_HIT_AT))
    ONE_HOUR_MS=3600000

    if [ "$ELAPSED_MS" -lt "$ONE_HOUR_MS" ]; then
      REMAINING_MIN=$(( (ONE_HOUR_MS - ELAPSED_MS) / 60000 ))
      log "INFO: Limit hit $((ELAPSED_MS / 60000))m ago — skipping (${REMAINING_MIN}m remaining)"
      exit 0
    else
      log "INFO: Limit cooldown expired — clearing limitHitAt"
      node -e "
        const fs = require('fs');
        const s = JSON.parse(fs.readFileSync('$STATE_FILE', 'utf8'));
        s.limitHitAt = null;
        fs.writeFileSync('$STATE_FILE', JSON.stringify(s, null, 2));
      " 2>/dev/null || true
    fi
  fi

  # Count in-progress jobs
  IN_PROGRESS_COUNT=$(node -e "
    const s = require('$STATE_FILE');
    const count = Object.values(s.jobs || {}).filter(j => j.status === 'IN_PROGRESS').length;
    console.log(count);
  " 2>/dev/null || echo "0")

  log "INFO: In-progress jobs: $IN_PROGRESS_COUNT"
fi

# ─── Run runtime ────────────────────────────────────────
log "INFO: Starting AgentLink Runtime (mode=$MODE)"

EXIT_CODE=0
node "$SCRIPT_DIR/runner/index.js" >> "$LOG_FILE" 2>&1 || EXIT_CODE=$?

log "INFO: Runtime exited with code $EXIT_CODE"

# Rotate log if it gets too large (>10MB)
if [ -f "$LOG_FILE" ]; then
  LOG_SIZE=$(wc -c < "$LOG_FILE" 2>/dev/null || echo "0")
  if [ "$LOG_SIZE" -gt 10485760 ]; then
    mv "$LOG_FILE" "${LOG_FILE}.old"
    log "INFO: Log rotated (was ${LOG_SIZE} bytes)"
  fi
fi

exit $EXIT_CODE
