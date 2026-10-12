#!/usr/bin/env bash
# This lab changes only newly created namespaces on a disposable Linux CI runner.
set -euo pipefail
test "${CI:-}" = true || { echo 'Run only on a disposable CI runner'; exit 1; }
topology="${1:-routed}"
case "$topology" in routed|bridged) ;; *) exit 2 ;; esac
node_bin=$(command -v node)
fixture=$(mktemp -d)
names=(clan-btc2a-a clan-btc2a-b clan-btc2a-r)
for name in "${names[@]}"; do
  if sudo ip netns list | awk '{print $1}' | grep -Fxq "$name"; then echo 'Lab namespace already exists; abort'; exit 1; fi
done
pids=()
cleanup() { cat "$fixture/"*.log 2>/dev/null || true; for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done; for name in "${names[@]}"; do sudo ip netns delete "$name"; done; }
trap cleanup EXIT
for name in "${names[@]}"; do sudo ip netns add "$name"; sudo ip -n "$name" link set lo up; done
sudo ip link add clan-a type veth peer name clan-ra
sudo ip link add clan-b type veth peer name clan-rb
sudo ip link set clan-a netns clan-btc2a-a
sudo ip link set clan-ra netns clan-btc2a-r
sudo ip link set clan-b netns clan-btc2a-b
sudo ip link set clan-rb netns clan-btc2a-r
sudo ip -n clan-btc2a-a addr add 10.71.0.2/24 dev clan-a
if test "$topology" = bridged; then
  sudo ip -n clan-btc2a-r link add clan-br type bridge
  sudo ip -n clan-btc2a-r link set clan-ra master clan-br
  sudo ip -n clan-btc2a-r link set clan-rb master clan-br
  sudo ip -n clan-btc2a-r addr add 10.71.0.1/24 dev clan-br
  sudo ip -n clan-btc2a-r link set clan-br up
  sudo ip -n clan-btc2a-b addr add 10.71.0.3/24 dev clan-b
else
  sudo ip -n clan-btc2a-r addr add 10.71.0.1/24 dev clan-ra
  sudo ip -n clan-btc2a-b addr add 10.72.0.2/24 dev clan-b
  sudo ip -n clan-btc2a-r addr add 10.72.0.1/24 dev clan-rb
fi
sudo ip -n clan-btc2a-a link set clan-a up
sudo ip -n clan-btc2a-b link set clan-b up
sudo ip -n clan-btc2a-r link set clan-ra up
sudo ip -n clan-btc2a-r link set clan-rb up
if test "$topology" = routed; then
  sudo ip -n clan-btc2a-a route add 10.72.0.0/24 via 10.71.0.1
  sudo ip -n clan-btc2a-b route add 10.71.0.0/24 via 10.72.0.1
  sudo ip netns exec clan-btc2a-r sysctl -qw net.ipv4.ip_forward=1
fi
for role in directory a b; do
  ns="clan-btc2a-$role"; test "$role" != directory || ns=clan-btc2a-r
  sudo ip netns exec "$ns" env CLAN_TOPOLOGY="$topology" "$node_bin" tools/sim/lan-topology.ts "$role" "$fixture" > "$fixture/$role.log" 2>&1 &
  pids+=("$!")
done
wait_file() { for ((i=0;i<180;i++)); do test ! -f "$fixture/$1" || return 0; sleep 1; done; cat "$fixture/"*.log; exit 1; }
wait_file disconnect.request
sudo ip -n clan-btc2a-r link set clan-rb down
printf ready > "$fixture/disconnected.ready"
wait_file queued.done
if test "$topology" = bridged; then
  sudo ip -n clan-btc2a-b addr del 10.71.0.3/24 dev clan-b
  sudo ip -n clan-btc2a-b addr add 10.71.0.4/24 dev clan-b
else
  sudo ip -n clan-btc2a-b addr del 10.72.0.2/24 dev clan-b
  sudo ip -n clan-btc2a-b addr add 10.72.0.3/24 dev clan-b
  sudo ip -n clan-btc2a-b route replace 10.71.0.0/24 via 10.72.0.1
fi
sudo ip -n clan-btc2a-r link set clan-rb up
printf ready > "$fixture/reconnected.ready"
wait_file a.done
wait_file b.done
wait "${pids[1]}"
wait "${pids[2]}"
cat "$fixture/a.log" "$fixture/b.log"
