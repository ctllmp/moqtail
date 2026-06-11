#!/usr/bin/env bash
#
# Step the ingress link through a fixed network regime, so that PF-ABR /
# MCTS-MoQ / BOLA-MoQ / Throughput tabs all observe an identical sequence of
# conditions and the resulting CSVs are directly comparable.
#
# Usage:
#   ./bench/throttle.sh [iface]
#
# Defaults to wlo1. Needs sudo (uses tc netem + ifb).
#
# Sequence (total ~2.5 min):
#   phase 1: unthrottled         (30 s) — let everyone settle
#   phase 2: mild  4 Mbps / 20 ms (30 s)
#   phase 3: tight 1.5 Mbps / 30 ms (30 s)
#   phase 4: severe 600 kbps / 80 ms / 1% loss (30 s)
#   phase 5: recovery, unthrottled (30 s)
#
# Workflow:
#   1. Open four tabs (one per algorithm) at the player.
#   2. Subscribe in all four; wait for the first decision in each.
#   3. Hit "Reset" in all four to drop pre-script noise.
#   4. Run this script.
#   5. When it finishes, hit "CSV" in each tab.
#   6. Feed those CSVs to bench/aggregate.ts.

set -e

IFACE="${1:-wlo1}"

trap cleanup EXIT INT TERM
cleanup() {
  echo
  echo "[throttle] cleanup: removing qdisc on $IFACE / ifb0"
  sudo tc qdisc del dev "$IFACE" ingress 2>/dev/null || true
  sudo tc qdisc del dev ifb0 root 2>/dev/null || true
  sudo ip link set ifb0 down 2>/dev/null || true
}

setup() {
  sudo modprobe ifb
  sudo ip link add ifb0 type ifb 2>/dev/null || true
  sudo ip link set ifb0 up
  sudo tc qdisc add dev "$IFACE" handle ffff: ingress 2>/dev/null || true
  sudo tc filter add dev "$IFACE" parent ffff: protocol ip u32 match u32 0 0 action mirred egress redirect dev ifb0
}

apply() {
  sudo tc qdisc replace dev ifb0 root netem "$@"
}

remove() {
  sudo tc qdisc del dev ifb0 root 2>/dev/null || true
}

banner() {
  local title="$1"
  local detail="$2"
  printf '\n[throttle] ==== %s ==== %s\n' "$title" "$detail"
  printf '[throttle] %s\n' "$(date '+%H:%M:%S')"
}

echo "[throttle] interface: $IFACE"
echo "[throttle] phases:"
echo "  1. unthrottled         (30 s)"
echo "  2. 4 Mbps / 20 ms      (30 s)"
echo "  3. 1.5 Mbps / 30 ms    (30 s)"
echo "  4. 600 kbps / 80 ms / 1% loss (30 s)"
echo "  5. recovery, no limit  (30 s)"
echo
read -r -p "Reset all browser tabs, then press Enter to start. "

setup

banner "phase 1" "no limit"
remove
sleep 30

banner "phase 2" "4 Mbps / 20 ms"
apply rate 4mbit delay 20ms
sleep 30

banner "phase 3" "1.5 Mbps / 30 ms"
apply rate 1500kbit delay 30ms
sleep 30

banner "phase 4" "600 kbps / 80 ms / 1% loss"
apply rate 600kbit delay 80ms loss 1%
sleep 30

banner "phase 5" "no limit (recovery)"
remove
sleep 30

echo
echo "[throttle] sequence complete. Download CSV from each tab now."
