# runner-toolcache — where the runner tool cache lives. Sets $TOOLCACHE.
#
# Sourced/inlined by every writer of a runner's .env, so the rule is stated once:
# it was stated twice before, and the two copies disagreed.
#
# /opt/hostedtoolcache, owned by the node's ci user (src/lib/node-users.ts) and
# populated with Python (3.11.15, 3.12.13). It was per-user once: the retired
# `openclaw` instances could not traverse the other user's home, into which
# /opt/hostedtoolcache/Python is a symlink farm, and needed their own seeded
# copy. The same trap applies to a ci user moved off admin: the farm must move
# with it (docs/planning/node-users-2026-10-27.md §4).
#
# Getting this wrong is silent: setup-python finds no interpreter and falls
# through to a download that cannot succeed on Debian 13, so a job passes or
# fails depending on which instance picked it up. Found 2026-08-18, on 16 runners.
TOOLCACHE=/opt/hostedtoolcache
