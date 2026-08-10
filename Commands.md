S = max(0, 100 - 40·failureRate - min(30, alertPenalty) - 15·contention - 15·I(sampleSize <
5))

contentionScore = min(logCount / 20, 1.0)

-------------------------

1. Env setup

// bash
export RPC="$MONAD_TESTNET_RPC_URL"
export PK="<your-private-key>"
export AMM=0x7567C23BE5CB52F3B270562180776A95f1bbCa8e
export TOKEN=0x4832448eC5578b84c7b13E3EeBA2370Ccfbd5579

2. Mint DEMO (testnet, anyone can mint)

// bash
cast send $TOKEN "mint(address,uint256)" $(cast wallet address --private-key $PK) 1000000000000000000000 --rpc-url $RPC --private-key $PK


# mints 1,000 DEMO
3. Approve the AMM to pull your DEMO
// bash
cast send $TOKEN "approve(address,uint256)" $AMM 1000000000000000000000 --rpc-url $RPC --private-key $PK
4. Add liquidity — DEMO + MON in one tx
// bash
cast send $AMM "addLiquidity(uint256)" 1000000000000000000000 \
  --value 100000000000000000000 \
  --rpc-url $RPC --private-key $PK
# adds 1,000 DEMO + 100 MON (18 decimals each)
5. Verify
// bash
cast call $AMM "getReserves()(uint256,uint256)" --rpc-url $RPC
# returns (tokenReserve, monReserve)
Topping up ONE side later (only after the pool exists)
// bash
# MON-only: tokenAmount = 0
cast send $AMM "addLiquidity(uint256)" 0 --value 50000000000000000000 --rpc-url $RPC --private-key $PK
 
# DEMO-only: no --value
cast send $AMM "addLiquidity(uint256)" 500000000000000000000 --rpc-url $RPC --private-key $PK





-----------CONTENTION ---------------
cd ~/VANTAGE/vantage/backend
./node_modules/.bin/tsx scripts/prove-contention.ts
./node_modules/.bin/tsx scripts/prove-contention.ts

------------------------------------------
cast send "$AMM" "addLiquidity(uint256)" "$AMOUNT" --rpc-url "$MONAD_TESTNET_RPC_URL" --private-key "$PRIVATE_KEY"