module.exports = {
  apps: [{
    name: "kalshi-bot",
    script: "src/main.ts",
    interpreter: "node",
    interpreter_args: "--import tsx",
    cwd: __dirname,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 30000,
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "logs/error.log",
    out_file: "logs/output.log",
    merge_logs: true,
  }],
};
