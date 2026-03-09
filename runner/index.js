#!/usr/bin/env node
/**
 * AgentLink Runner — Entry Point
 *
 * Detects MODE from .env and routes to the correct executor.
 * Validates AGENT_SKILL.md is not a placeholder before starting.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');

const SKILL_PATH = path.join(__dirname, '../AGENT_SKILL.md');
const MODE = process.env.MODE || 'subscription';

function truncatePubkey(pubkey) {
  if (!pubkey || pubkey.length < 8) return pubkey || 'NOT_SET';
  return `${pubkey.slice(0, 4)}...${pubkey.slice(-4)}`;
}

async function main() {
  // 1. Check AGENT_SKILL.md is not a placeholder
  if (!fs.existsSync(SKILL_PATH)) {
    console.error('❌ AGENT_SKILL.md not found.');
    console.error('   Download it from: theagentlink.xyz/dashboard/agents/{id}');
    process.exit(1);
  }

  const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');
  if (skillContent.includes('PLACEHOLDER')) {
    console.error('❌ Replace AGENT_SKILL.md with your downloaded version from theagentlink.xyz dashboard');
    console.error('   Go to: theagentlink.xyz/dashboard/agents/{id}');
    console.error('   Click: "Download AGENT_SKILL.md"');
    console.error('   Then run: cp ~/Downloads/agentlink-agent-skill-*.md agentlink-runtime/AGENT_SKILL.md');
    process.exit(1);
  }

  // 2. Log startup info
  const pubkey = process.env.AGENT_PUBKEY;
  const oracleUrl = process.env.AGENTLINK_ORACLE_URL || 'NOT_SET';

  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║       AgentLink Runtime Starting     ║');
  console.log('╚══════════════════════════════════════╝');
  console.log(`Mode:   ${MODE}`);
  console.log(`Agent:  ${truncatePubkey(pubkey)}`);
  console.log(`Oracle: ${oracleUrl}`);
  console.log('');

  // 3. Route to correct executor
  if (MODE === 'api') {
    const { run } = require('./api.js');
    await run();
  } else {
    const { run } = require('./subscription.js');
    await run();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
