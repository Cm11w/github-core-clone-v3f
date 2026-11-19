#!/bin/bash
# End-to-end battery with the real git CLI + curl against a fresh server.
# Usage: bash tests/e2e.sh  (from the entry directory)
# Every check is a shell function run directly (no bash -c strings), so
# quoting stays correct. Each git/curl call is bounded by `timeout`.
set -u
cd "$(dirname "$0")/.." || exit 1

TOKEN="e2e-token-$$"
PORT=$((19500 + RANDOM % 400))
BASE="http://127.0.0.1:$PORT"
WORK="$(mktemp -d)"
export GIT_CONFIG_GLOBAL="$WORK/gitconfig"
export GIT_CONFIG_SYSTEM=/dev/null
export HOME="$WORK"
PASS=0
FAIL=0
FAILED_NAMES=()

MAKEFUN_SHOP_TOKEN="$TOKEN" PORT="$PORT" node main.ts > "$WORK/server.log" 2>&1 &
SRVPID=$!
cleanup() {
  kill "$SRVPID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
for _ in $(seq 1 50); do
  curl -s -m 1 "$BASE/healthz" >/dev/null 2>&1 && break
  sleep 0.1
done

check() {
  local name="$1"; shift
  if "$@" > "$WORK/last.out" 2>&1; then
    PASS=$((PASS + 1)); echo "ok   - $name"
  else
    FAIL=$((FAIL + 1)); FAILED_NAMES+=("$name"); echo "FAIL - $name"
    sed 's/^/       /' "$WORK/last.out" | head -n 8
  fi
}

# git with identity + bearer header, bounded by timeout.
G() {
  timeout 60 git -c user.name="E2E Tester" -c user.email="e2e@example.invalid" \
    -c commit.gpgsign=false -c "http.extraHeader=Authorization: Bearer $TOKEN" "$@"
}
# curl with bearer header.
C() {
  timeout 30 curl -s -H "Authorization: Bearer $TOKEN" "$@"
}

# --- 1. health + REST basics -----------------------------------------------
t_healthz() { curl -s -f -m 10 "$BASE/healthz" >/dev/null; }
t_unauth_401() { test "$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/api/v3/user")" = "401"; }
t_create_repo() { C -H 'Content-Type: application/json' -d '{"name":"e2e-main"}' "$BASE/api/v3/user/repos" | grep -q '"name":"e2e-main"'; }
t_duplicate_422() { test "$(C -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"name":"e2e-main"}' "$BASE/api/v3/user/repos")" = "422"; }

# --- 2. empty clone + first push -------------------------------------------
t_clone_empty() { (cd "$WORK" && G clone -q "$BASE/adaiversen/e2e-main.git" empty1) && test -d "$WORK/empty1/.git"; }
t_push_first() { (cd "$WORK/empty1" && git checkout -q -b main && echo hello > a.txt && G add a.txt && G commit -qm 'first commit' && G push -q origin main); }
t_clone_back() { (cd "$WORK" && G clone -q "$BASE/adaiversen/e2e-main.git" back1) && test "$(cat "$WORK/back1/a.txt")" = "hello"; }
t_fsck() { (cd "$WORK/back1" && G fsck --strict >/dev/null 2>&1); }

# --- 3. tags ----------------------------------------------------------------
t_tags() { (cd "$WORK/back1" && G tag -a v1.0 -m 'release 1.0' && G tag light1 && G push -q origin v1.0 light1); }
t_peeled() { G ls-remote "$BASE/adaiversen/e2e-main.git" | grep -q 'refs/tags/v1.0\^{}'; }

# --- 4. slashed branch -------------------------------------------------------
t_slashed_push() { (cd "$WORK/back1" && G checkout -qb feature/deep/nested && echo more >> a.txt && G commit -qam 'second commit' && G push -q origin feature/deep/nested); }
t_slashed_clone() { (cd "$WORK" && G clone -q --branch feature/deep/nested "$BASE/adaiversen/e2e-main.git" slashed) && test -d "$WORK/slashed/.git"; }

# --- 4b. second commit on main (gives the shallow clone a parent to deepen into)
t_main_second() { (cd "$WORK/back1" && G checkout -q main && echo second > b.txt && G add b.txt && G commit -qm 'second commit on main' && G push -q origin main); }

# --- 5. shallow + deepen -----------------------------------------------------
t_shallow1() { (cd "$WORK" && G clone -q --depth 1 "$BASE/adaiversen/e2e-main.git" shallow1) && test "$(G -C "$WORK/shallow1" rev-list --count HEAD)" = "1"; }
t_deepen1() { (cd "$WORK/shallow1" && G fetch -q --deepen=1 origin) && test "$(G -C "$WORK/shallow1" rev-list --count HEAD)" = "2"; }

# --- 6. partial clone + lazy fetch -------------------------------------------
t_partial() {
  (cd "$WORK" && G clone -q --filter=blob:none "$BASE/adaiversen/e2e-main.git" partial1) &&
    test "$(G -C "$WORK/partial1" cat-file -p HEAD:a.txt)" = "hello"
}

# --- 7. protocol v0 -----------------------------------------------------------
t_v0_clone() { (cd "$WORK" && timeout 60 git -c protocol.version=0 -c user.name="E2E Tester" -c user.email="e2e@example.invalid" -c "http.extraHeader=Authorization: Bearer $TOKEN" clone -q "$BASE/adaiversen/e2e-main.git" v0clone) && test -d "$WORK/v0clone/.git"; }

# --- 8. non-fast-forward -------------------------------------------------------
t_nonff() {
  (cd "$WORK" && G clone -q "$BASE/adaiversen/e2e-main.git" ff1 && G clone -q "$BASE/adaiversen/e2e-main.git" ff2) &&
  (cd "$WORK/ff1" && echo one > f.txt && G add f.txt && G commit -qm c1 && G push -q origin main) &&
  (cd "$WORK/ff2" && echo two > f.txt && G add f.txt && G commit -qm c2 &&
    { ! G push origin main > "$WORK/ff.out" 2>&1; } &&
    grep -q '\[rejected\]' "$WORK/ff.out" &&
    { ! G push --force origin main > "$WORK/ffforce.out" 2>&1; } &&
    grep -q '(non-fast-forward)' "$WORK/ffforce.out")
}

# --- 9. merge commit ------------------------------------------------------------
t_merge_commit() {
  (cd "$WORK/back1" && G checkout -q main && G pull -q origin main &&
    G merge -q --no-ff feature/deep/nested -m 'merge feature' && G push -q origin main)
}

# --- 10. large push --------------------------------------------------------------
t_big_push() {
  (cd "$WORK/back1" && head -c 5242880 /dev/urandom > big.bin && G add big.bin && G commit -qm 'big blob' && G push -q origin main)
}

# --- 10b. delta pack (similar large blobs -> OFS_DELTA) ---------------------------
t_delta_pack() {
  (cd "$WORK/back1" &&
    seq 1 3000 > delta.txt && G add delta.txt && G commit -qm 'delta base' && G push -q origin main &&
    sed -i 's/^1500$/1500-modified/' delta.txt && G commit -qam 'delta change 1' && G push -q origin main &&
    sed -i 's/^2999$/2999-modified/' delta.txt && G commit -qam 'delta change 2' && G push -q origin main) &&
  (cd "$WORK" && G clone -q "$BASE/adaiversen/e2e-main.git" deltaclone) &&
  cmp "$WORK/back1/delta.txt" "$WORK/deltaclone/delta.txt"
}

# --- 11. concurrent pushes, different branches ------------------------------------
t_concurrent() {
  (cd "$WORK" && G clone -q "$BASE/adaiversen/e2e-main.git" conc1 && G clone -q "$BASE/adaiversen/e2e-main.git" conc2) || return 1
  (cd "$WORK/conc1" && G checkout -qb conc-a && echo a > ca.txt && G add ca.txt && G commit -qm ca && G push -q origin conc-a) &
  local p1=$!
  (cd "$WORK/conc2" && G checkout -qb conc-b && echo b > cb.txt && G add cb.txt && G commit -qm cb && G push -q origin conc-b) &
  local p2=$!
  wait "$p1"; local s1=$?
  wait "$p2"; local s2=$?
  test "$s1" -eq 0 && test "$s2" -eq 0
}

# --- 12. same-branch race: exactly one winner --------------------------------------
t_race() {
  (cd "$WORK" && G clone -q "$BASE/adaiversen/e2e-main.git" race1 && G clone -q "$BASE/adaiversen/e2e-main.git" race2) || return 1
  (cd "$WORK/race1" && G checkout -qb race && echo r1 > r.txt && G add r.txt && G commit -qm r1 && G push -q origin race; echo $? > "$WORK/race1.rc") &
  local p1=$!
  (cd "$WORK/race2" && G checkout -qb race && echo r2 > r.txt && G add r.txt && G commit -qm r2 && G push -q origin race; echo $? > "$WORK/race2.rc") &
  local p2=$!
  wait "$p1"; wait "$p2"
  test "$(( $(cat "$WORK/race1.rc") + $(cat "$WORK/race2.rc") ))" -eq 1
}

# --- 13. contents %2F + REST issue/PR/merge -----------------------------------------
t_contents() { C "$BASE/api/v3/repos/adaiversen/e2e-main/contents/a.txt" | grep -q '"type":"file"'; }
t_contents_pct() { C "$BASE/api/v3/repos/adaiversen/e2e-main/contents/a%2etxt" | grep -q '"type":"file"'; }
t_issue() { C -H 'Content-Type: application/json' -d '{"title":"bug here","body":"details"}' "$BASE/api/v3/repos/adaiversen/e2e-main/issues" | grep -q '"number":1'; }
t_pr() { C -H 'Content-Type: application/json' -d '{"title":"pr one","head":"conc-a","base":"main"}' "$BASE/api/v3/repos/adaiversen/e2e-main/pulls" | grep -q '"number":2'; }
t_merge_pr() { C -X PUT -H 'Content-Type: application/json' -d '{"merge_method":"squash"}' "$BASE/api/v3/repos/adaiversen/e2e-main/pulls/2/merge" | grep -q '"merged":true'; }

# --- 14. GraphQL ----------------------------------------------------------------------
t_gql_invalid() { C -H 'Content-Type: application/json' -d '{"query":"{ viewer { noSuchFieldOnViewer } }"}' "$BASE/api/graphql" | grep -q noSuchFieldOnViewer; }
t_gql_batch() { C -H 'Content-Type: application/json' -d '[{"query":"{ viewer { login } }"},{"query":"{ viewer { login } }"}]' "$BASE/api/graphql" | grep -q 'adaiversen'; }

# --- 15. MCP ----------------------------------------------------------------------------
t_mcp_list() { C -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' "$BASE/mcp" | grep -q create_repo; }
t_mcp_call() { C -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_repo","arguments":{"name":"e2e-mcp-repo"}}}' "$BASE/mcp" | grep -q e2e-mcp-repo; }

# --- 16. malformed input + probe ----------------------------------------------------------
t_malformed() {
  test "$(printf 'zzzznot-a-pkt-line' | C -H 'Content-Type: application/x-git-upload-pack-request' --data-binary @- -o /dev/null -w '%{http_code}' "$BASE/adaiversen/e2e-main.git/git-upload-pack")" = "400" &&
  curl -s -f -m 10 "$BASE/healthz" >/dev/null
}
t_probe() { printf '0000' | C -H 'Content-Type: application/x-git-receive-pack-request' --data-binary @- "$BASE/adaiversen/e2e-main.git/git-receive-pack" | grep -q 'unpack ok'; }

check "healthz" t_healthz
check "unauthenticated REST is 401" t_unauth_401
check "create repo e2e-main" t_create_repo
check "duplicate repo is 422" t_duplicate_422
check "clone empty repo" t_clone_empty
check "push first commit" t_push_first
check "clone back byte-identical" t_clone_back
check "fsck clean on clone-back" t_fsck
check "annotated + lightweight tags" t_tags
check "ls-remote shows peeled tag" t_peeled
check "slashed branch push" t_slashed_push
check "clone slashed branch" t_slashed_clone
check "second commit on main" t_main_second
check "shallow clone depth 1" t_shallow1
check "deepen by 1" t_deepen1
check "blob:none clone + lazy fetch" t_partial
check "protocol v0 clone" t_v0_clone
check "non-FF push rejected" t_nonff
check "merge commit push" t_merge_commit
check "5 MiB blob push" t_big_push
check "delta pack round-trip" t_delta_pack
check "concurrent pushes" t_concurrent
check "same-branch race one winner" t_race
check "contents path" t_contents
check "contents percent-encoded path" t_contents_pct
check "create issue via REST" t_issue
check "create PR via REST" t_pr
check "merge PR via REST" t_merge_pr
check "graphql invalid field errors" t_gql_invalid
check "graphql batch" t_gql_batch
check "mcp tools/list" t_mcp_list
check "mcp tools/call create_repo" t_mcp_call
check "malformed upload-pack does not kill server" t_malformed
check "receive-pack probe 0000 unpack ok" t_probe

echo
echo "e2e: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "failed: ${FAILED_NAMES[*]}"
  exit 1
fi
