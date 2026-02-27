const fs = require('fs');

const lines = [
  `REACT_APP_BUILD_TIMESTAMP=${new Date().toISOString()}`,
  `REACT_APP_COMMIT_SHA=${process.env.VERCEL_GIT_COMMIT_SHA || 'local'}`,
];

fs.writeFileSync('.env.production.local', lines.join('\n') + '\n');
