set -ex
export NETWORK=kovan-ovm-futures 
node src/ run -p wss://ws-kovan.optimism.io --from-block 0 -n 1
