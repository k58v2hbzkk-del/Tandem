#!/usr/bin/env bash
# Local end-to-end run: anvil (chain 133) + mock HSP MCP + the real app.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH=$PATH:/root/.foundry/bin
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # deployer / relayer
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412eac4ea4e8b9b46   # payer (client agent)
K2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a   # mock gateway
PAYER=$(cast wallet address --private-key $K1)
pkill -f "anvil --port 8546" 2>/dev/null || true; pkill -f mock-hsp.mjs 2>/dev/null || true; pkill -f "app/server.mjs" 2>/dev/null || true
anvil --port 8546 --chain-id 133 --silent & sleep 2
RPC=http://127.0.0.1:8546
FACTORY=$(cd contracts && forge create src/Tandem.sol:TandemFactory --rpc-url $RPC --private-key $K0 --broadcast 2>/dev/null | grep "Deployed to" | awk '{print $3}')
TOKEN=$(cd contracts && forge create test/mocks/MockUSDC.sol:MockUSDC --rpc-url $RPC --private-key $K0 --broadcast 2>/dev/null | grep "Deployed to" | awk '{print $3}')
cast send $TOKEN "mint(address,uint256)" $PAYER 5000000 --rpc-url $RPC --private-key $K0 >/dev/null
echo "factory $FACTORY token $TOKEN"
RPC=$RPC TOKEN=$TOKEN GATEWAY_KEY=$K2 MOCK_PORT=7070 node test/mock-hsp.mjs >/tmp/mock.log 2>&1 &
sleep 1
rm -rf /tmp/ts-data
HSK_TESTNET_RPC=$RPC HSP_MCP_URL=http://127.0.0.1:7070/ FACTORY=$FACTORY PAYER_KEY=$K1 RELAYER_KEY=$K0 ADMIN_TOKEN=secret HSP_TEAM_NAME=Tandem DATA_DIR=/tmp/ts-data PORT=3999 node app/server.mjs >/tmp/app.log 2>&1 &
sleep 2
H='-H x-admin-token:secret -H content-type:application/json'
JOB=$(curl -s $H -d '{"request":"Market brief on HSK","usd":1.5}' http://127.0.0.1:3999/api/jobs)
ID=$(echo "$JOB" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
echo "job $ID status $(echo "$JOB" | node -pe 'const j=JSON.parse(require("fs").readFileSync(0));j.status+" "+(j.error||"")')"
curl -s $H -d '{"step":"sign"}' http://127.0.0.1:3999/api/jobs/$ID/approve | node -pe 'const j=JSON.parse(require("fs").readFileSync(0));"after sign: "+j.status+" "+(j.error||"")'
curl -s $H -d '{"step":"submit"}' http://127.0.0.1:3999/api/jobs/$ID/approve | node -pe 'const j=JSON.parse(require("fs").readFileSync(0));"after submit: "+j.status+" "+(j.error||"")'
sleep 4
curl -s http://127.0.0.1:3999/api/state | node -e '
const s=JSON.parse(require("fs").readFileSync(0));const j=s.jobs[0];
console.log("final:",j.status,j.error||"");for(const l of j.log)console.log(" -",l.msg);
console.log("members:",s.members.map(m=>m.name+" "+m.address).join(" | "));' 
for a in $(curl -s http://127.0.0.1:3999/api/state | node -pe 'JSON.parse(require("fs").readFileSync(0)).members.map(m=>m.address).join(" ")'); do
  echo "balance $a: $(cast call $TOKEN 'balanceOf(address)(uint256)' $a --rpc-url $RPC)"; done
echo "payer left: $(cast call $TOKEN 'balanceOf(address)(uint256)' $PAYER --rpc-url $RPC)"
[ "${KEEP:-}" = 1 ] || { pkill -f "anvil --port 8546"; pkill -f mock-hsp.mjs; pkill -f "app/server.mjs"; }
