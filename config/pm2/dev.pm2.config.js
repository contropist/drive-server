module.exports = {
  apps: [{
    name: 'xcloud_staging',
    script: './app.js',
    env: {
      NODE_ENV: 'development',
    }
  }]
}
