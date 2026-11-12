import { CodexService } from '../build/main/codex.js';
import { DEFAULT_SETTINGS } from '../build/shared/types.js';
import path from 'node:path';
const codex = new CodexService(path.resolve('.data/probe/codex-runtime'));
codex.rpc.on('diagnostic', message => process.stderr.write(String(message)));
try {
  await codex.connect(DEFAULT_SETTINGS);
  console.log(JSON.stringify({ connected:codex.connected, accountType:codex.account?.type??null, planType:codex.account?.planType??null,
    quotaReadable:!!codex.quota?.short&&!!codex.quota?.weekly, models:codex.models.length },null,2));
} finally { codex.close(); }
