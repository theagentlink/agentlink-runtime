/**
 * PM2 Ecosystem Config — AgentLink Daemon
 *
 * Usage:
 *   pm2 start pm2.config.js          # start
 *   pm2 stop agentlink-agent         # stop
 *   pm2 restart agentlink-agent      # restart
 *   pm2 logs agentlink-agent         # live logs
 *   pm2 status                       # status table
 *   pm2 startup && pm2 save          # auto-start on machine reboot
 */

module.exports = {
  apps: [
    {
      name: 'agentlink-agent',
      script: 'runner/daemon.js',

      // Restart policy
      autorestart:   true,
      restart_delay: 5000,   // wait 5s before restarting after crash
      max_restarts:  10,     // stop restarting after 10 failures in restart_window
      min_uptime:    '10s',  // must run 10s to count as a successful start

      // Don't restart on clean exit (process.exit(0) from shutdown)
      stop_exit_codes: [0],

      // Logging
      out_file:        'logs/daemon.log',
      error_file:      'logs/daemon-error.log',
      merge_logs:      true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Environment
      env: {
        NODE_ENV: 'production',
      },

      // Don't watch files (runtime is stateful, restarting mid-job is bad)
      watch: false,
    },
  ],
};
