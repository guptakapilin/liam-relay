const fs = require('fs');
const path = require('path');

/**
 * Loads the sync log and resolves environment variables embedded as "env:VARNAME".
 * Returns the parsed object with actual folder IDs populated from process.env.
 */
function loadSyncLog() {
  const filePath = path.join(__dirname, '../data/sync-log.json');

  if (!fs.existsSync(filePath)) {
    throw new Error('sync-log.json not found in /data folder');
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const log = JSON.parse(raw);

  for (const agentName of Object.keys(log.agents)) {
    const agent = log.agents[agentName];

    for (const key of ['unifiedFolderId', 'archivesFolderId']) {
      if (agent[key] && agent[key].startsWith('env:')) {
        const envVar = agent[key].split('env:')[1];
        const resolved = process.env[envVar];

        if (!resolved) {
          throw new Error(`Missing ENV variable: ${envVar}`);
        }

        agent[key] = resolved;
      }
    }
  }

  return log;
}

module.exports = loadSyncLog;
