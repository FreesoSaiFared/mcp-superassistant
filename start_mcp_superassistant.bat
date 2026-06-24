@echo off
cd /d "E:\MCP-SuperAssistant"
pm2 start start.js --name "MCP-SuperAssistant" --interpreter "node" --node-args "--experimental-modules"
exit
