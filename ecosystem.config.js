module.exports = {
  apps : [{
    name: "logbot",
    script: "./index.js",
    args: "--server",
    watch: true,
    // This ignores all .json files and the node_modules folder
    watch: ["restart.flag"],
    ignore_watch: ["node_modules", "*.json", "package-lock.json"],
    env: {
      NODE_ENV: "development",
    },
    env_production: {
      NODE_ENV: "production",
    }
  }]
}