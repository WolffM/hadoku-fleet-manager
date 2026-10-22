# runner-toolcache — where THIS user's runner tool cache lives. Sets $TOOLCACHE.
#
# Sourced/inlined by every writer of a runner's .env, so the rule is stated once:
# it was stated twice before, and the two copies disagreed. `fix-runner-tool-cache.sh`
# hardcoded /opt/hostedtoolcache for everyone, which is not merely wrong for the
# openclaw instances — running it there would have chowned the shared hadoku tree
# to openclaw and broken all 16 hadoku runners at once.
#
#   hadoku   -> /opt/hostedtoolcache. It owns that tree, and it is the one
#               populated with Python (3.11.15, 3.12.13).
#   openclaw -> $HOME/hostedtoolcache. It CANNOT traverse /home/hadoku (0700),
#               and /opt/hostedtoolcache/Python is a symlink farm into that home,
#               so the shared cache is genuinely useless here — each openclaw
#               runner needs its own seeded copy. Seed with seed-runner-python.mjs.
#
# Getting this wrong is silent: setup-python finds no interpreter and falls
# through to a download that cannot succeed on Debian 13, so a job passes or
# fails depending on which instance picked it up. Found 2026-08-18, on 16 runners.
if [ "$(id -un)" = "openclaw" ]; then
	TOOLCACHE="$HOME/hostedtoolcache"
else
	TOOLCACHE=/opt/hostedtoolcache
fi
