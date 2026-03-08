module.exports = {
  host: process.env.MC_HOST || 'localhost',
  port: parseInt(process.env.MC_PORT) || 25565,
  username: process.env.MC_USERNAME || 'LumberjackBot',
  version: process.env.MC_VERSION || '1.20.1',
};
