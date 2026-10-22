#!/bin/sh
# cargo-bevy-proxy — the CHEAP stand-in for brave-quartet's Bevy workspace build.
#
# NOT YET WIRED. Committed with `payload-routing-2026-09-14.md` so the calibrated
# artifact survives the session that measured it; the registry entry and the
# `capability-probe.sh` block that would use it are step 3 of that doc.
#
# CALIBRATION, measured 2026-09-14 against the real payload on all seven claws
# (`cargo build --workspace --locked`, cold target/, on real disk):
#
#   node     build    proxy      node     build    proxy
#   claw-7    6.9m     3528      claw-2   24.0m     1521
#   claw-4   10.9m     2281      claw-5   33.4m      734
#   claw-6   17.0m     1529      claw-3   47.0m      923
#   claw-1   18.7m     1495
#
#   Spearman rank vs payload            0.929
#   Pearson (proxy vs 1/build-seconds)  0.984
#
# Proposed bar: >= 1200. Admits claw-7/4/6/1/2; excludes claw-5 (~43m predicted
# full `check`, 72% of the 60-minute runner TTL) and claw-3 (~61m, over it). The
# bar sits in a wide gap (923 -> 1495), so the one proxy inversion — claw-1 and
# claw-2 differ by 2% and rank swapped — cannot flip anyone across it.
#
# THE PROBE MEASURES, THE REGISTRY JUDGES: this prints a number and never
# decides. See `CapabilityMeasure` in src/capabilities.ts.
#
# Must fit inside capability-probe.sh's 180s budget alongside every other
# capability, so it cannot build a workspace. It compiles synthetic,
# monomorphisation-heavy crates with optimisations — the shape a Bevy build
# spends its time on — and prints monomorphisations per second.
#
# ALL-CORE, NOT SINGLE-CORE, and that is the whole design. A real cargo build is
# massively parallel: claw-7 spent 4,729 CPU-seconds over 427 wall seconds, or
# ~11 cores busy. A single-threaded rustc probe measures per-core throughput and
# is BLIND to core count, which would rank 2-core claw-3 above 8-core claw-5 and
# be wrong about the thing being routed. So it forks one rustc per core and
# measures the wall time of the batch — cores x per-core speed, which is what
# the payload actually consumes.
#
# NO NETWORK, NO REGISTRY, NO CARGO: `rustc` straight on generated files. A
# probe that needs crates.io fails on a node behind a firewall rather than on a
# node that is slow, and those are different findings.
set -u
PER_UNIT=1500
d=$(mktemp -d) || exit 1
trap 'rm -rf "$d"' EXIT
cd "$d" || exit 1

n=$(nproc 2>/dev/null || echo 1)

gen() {
  {
    echo 'trait Op { fn go(&self, x: u64) -> u64; }'
    echo 'struct M<const N: usize>;'
    echo 'impl<const N: usize> Op for M<N> {'
    echo '  #[inline(never)] fn go(&self, x: u64) -> u64 {'
    echo '    let mut a = x ^ (N as u64);'
    echo '    for i in 0..64u64 { a = a.wrapping_mul(0x9E3779B97F4A7C15).rotate_left((i % 31) as u32) ^ i; }'
    echo '    a'
    echo '  }'
    echo '}'
    echo 'fn main() {'
    echo '  let mut t = 0u64;'
    i=0
    while [ "$i" -lt "$PER_UNIT" ]; do
      echo "  t = t.wrapping_add(M::<$((i + $1 * PER_UNIT))>.go(t));"
      i=$((i + 1))
    done
    echo '  println!("{}", t);'
    echo '}'
  } > "u$1.rs"
}

u=0
while [ "$u" -lt "$n" ]; do gen "$u"; u=$((u + 1)); done

start=$(date +%s%N)
u=0
while [ "$u" -lt "$n" ]; do
  rustc -O -C codegen-units=1 --edition 2021 -o "u$u" "u$u.rs" 2>/dev/null &
  u=$((u + 1))
done
wait
end=$(date +%s%N)

u=0
while [ "$u" -lt "$n" ]; do
  [ -x "u$u" ] || { echo "COMPILE-FAILED"; exit 1; }
  u=$((u + 1))
done

ms=$(( (end - start) / 1000000 ))
[ "$ms" -lt 1 ] && ms=1
# Monomorphisations per second across the whole box. Higher is faster; printed
# as a bare integer so the registry's bar is a plain number.
echo $(( n * PER_UNIT * 1000 / ms ))
