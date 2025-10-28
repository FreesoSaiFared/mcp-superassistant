import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(new URL(import.meta.url).pathname.substring(1));

console.log('=======================================');
console.log('MCP SuperAssistant Proxy Starter');
console.log('=======================================');
console.log('');

const configFile = path.resolve(__dirname, 'config.json');

if (!fs.existsSync(configFile)) {
    console.error(`ERROR: config.json not found at ${configFile}`);
    console.error('Please ensure the config.json file exists in the root directory.');
    process.exit(1);
}

console.log(`Using configuration file: ${configFile}`);
console.log('Attempting to start the MCP proxy server via npx...');
console.log('This may take a moment to download the package if it is not cached.');
console.log('');

const command = 'npx';
const args = [
    '@srbhptl39/mcp-superassistant-proxy@latest',
    '--config',
    configFile
];

// For Windows, npx command needs to be run with shell = true
const isWindows = process.platform === 'win32';

const proxyProcess = spawn(command, args, {
    stdio: 'inherit',
    shell: isWindows,
    cwd: __dirname // Explicitly set the current working directory
});

proxyProcess.on('close', (code) => {
    console.log(`Proxy process exited with code ${code}`);
    if (code !== 0) {
        console.error('The proxy server failed to start or crashed.');
    }
});

proxyProcess.on('error', (err) => {
    console.error('Failed to start proxy process.');
    console.error(err);
});
