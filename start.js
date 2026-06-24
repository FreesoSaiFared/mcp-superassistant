import { fork } from 'child_process';
import path from 'path';

const __dirname = path.dirname(new URL(import.meta.url).pathname.substring(1));
const proxyScript = path.resolve(__dirname, 'start_proxy.js');

console.log('Starting MCP SuperAssistant Proxy...');

const child = fork(proxyScript, [], {
  stdio: 'inherit',
});

child.on('close', (code) => {
  console.log(`Main starter script exiting. Child process exited with code ${code}`);
});
