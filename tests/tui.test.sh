#!/bin/sh
# Tests skills/qa/scripts/tui.sh against a program that prompts, answers, and
# exits 3, on a tmux server of its own.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
TUI="$REPO/skills/qa/scripts/tui.sh"
export TMUX_TMPDIR="$TMP"
unset TMUX
trap 'tmux kill-server 2>/dev/null || true; tmux -S "$TMP/outer.sock" kill-server 2>/dev/null || true; rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# The default tmux socket is shared by every session on the machine, so tui.sh
# refuses to run until the caller gives it a server of its own.
out="$(env -u TMUX_TMPDIR sh "$TUI" show qa-t 2>&1)" && fail "tui.sh ran without TMUX_TMPDIR"
case $out in *TMUX_TMPDIR*) ;; *) fail "tui.sh did not name TMUX_TMPDIR: $out" ;; esac

# Missing sessions must fail rather than look like empty screens.
sh "$TUI" show qa-absent >"$TMP/show.out" 2>"$TMP/show.err" && fail "show passed without a session"
[ -s "$TMP/show.err" ] || fail "show lost the capture error"
sh "$TUI" colors qa-absent >"$TMP/colors.out" 2>"$TMP/colors.err" && fail "colors passed without a session"
[ -s "$TMP/colors.err" ] || fail "colors lost the capture error"

# An inherited tmux session must not override the private QA server.
tmux -S "$TMP/outer.sock" new-session -d -s outer 'sleep 60'
inherited=$(tmux -S "$TMP/outer.sock" display -p -t outer '#{socket_path},#{pid},0')
TMUX="$inherited" sh "$TUI" start qa-isolated 40 10 sh -c 'echo isolated; sleep 5'
tmux -S "$TMP/outer.sock" has-session -t qa-isolated 2>/dev/null && fail "start used the inherited server"
sh "$TUI" wait qa-isolated isolated 5 >/dev/null || fail "the private server did not start"
TMUX="$inherited" sh "$TUI" stop qa-isolated
tmux has-session -t qa-isolated 2>/dev/null && fail "stop used the inherited server"
tmux -S "$TMP/outer.sock" has-session -t outer || fail "the inherited session was changed"
tmux -S "$TMP/outer.sock" kill-server

# Launch paths can contain spaces and apostrophes, regardless of unrelated TMPDIR.
quoted_tmp="$TMP/launch's dir"
mkdir "$quoted_tmp"
export TMUX_TMPDIR="$quoted_tmp"
TMPDIR="$TMP/nonexistent" sh "$TUI" start qa-quoted 40 10 sh -c 'echo quoted-ready; sleep 5' \
  || fail "start depended on unrelated TMPDIR or rejected a quoted scratch path"
sh "$TUI" wait qa-quoted quoted-ready 5 >/dev/null || fail "a quoted launch path did not start"
for launch in "$quoted_tmp"/tui-launch.*; do
  [ ! -e "$launch" ] || fail "a successful launch left its script behind"
done
TMPDIR="$TMP/nonexistent" sh "$TUI" start qa-quoted 40 10 sh -c 'echo unwanted' \
  >"$TMP/duplicate.out" 2>"$TMP/duplicate.err" && fail "a duplicate session start passed"
for launch in "$quoted_tmp"/tui-launch.*; do
  [ ! -e "$launch" ] || fail "a rejected start left its launch script behind"
done
sh "$TUI" wait qa-quoted quoted-ready 5 >/dev/null || fail "a rejected start changed the existing session"
sh "$TUI" stop qa-quoted
export TMUX_TMPDIR="$TMP"

# Launch arguments reach the program byte-for-byte, without shell evaluation.
set -- "" "it's here" "one
" "two

" "
" "embedded
line" " 	 spaced " '雪' '$(touch injected); * `false` $HOME \"'
printf '%s\0' "$@" >"$TMP/argv.expected"
sh "$TUI" start qa-argv 80 24 sh -c 'printf "%s\0" "$@" >"$0"; exit 7' "$TMP/argv.actual" "$@" \
  || fail "argument recorder did not start"
tries=100
while [ "$(tmux display -p -t qa-argv '#{pane_dead}')" != 1 ] && [ "$tries" -gt 0 ]; do
  sleep 0.1
  tries=$((tries - 1))
done
cmp "$TMP/argv.expected" "$TMP/argv.actual" || fail "start changed argument bytes"
[ "$(tmux display -p -t qa-argv '#{pane_dead_status}')" = 7 ] || fail "argument recorder lost its exit status"
for launch in "$TMP"/tui-launch.*; do
  [ ! -e "$launch" ] || fail "argument recorder left its launch script behind"
done
sh "$TUI" stop qa-argv

# A pane can disappear after display/send-keys succeeds. Polling must propagate
# capture failure instead of accepting absent text or a stable empty screen.
mkdir "$TMP/fake-bin"
cat > "$TMP/fake-bin/tmux" <<'EOF'
#!/bin/sh
case $1 in
display) echo 0 ;;
capture-pane)
  if [ -n "${TUI_CAPTURE_ONCE:-}" ] && [ -f "$TUI_CAPTURE_ONCE" ]; then
    rm "$TUI_CAPTURE_ONCE"
    echo ready
  else
    echo 'capture failed' >&2
    exit 1
  fi
  ;;
*) exit 0 ;;
esac
EOF
chmod +x "$TMP/fake-bin/tmux"
PATH="$TMP/fake-bin:$PATH" sh "$TUI" gone qa-race text 1 >"$TMP/gone.out" 2>"$TMP/gone.err" && fail "gone passed after capture failed"
PATH="$TMP/fake-bin:$PATH" sh "$TUI" press qa-race x >"$TMP/press.out" 2>"$TMP/press.err" && fail "press passed after capture failed"
touch "$TMP/capture-once"
PATH="$TMP/fake-bin:$PATH" TUI_CAPTURE_ONCE="$TMP/capture-once" sh "$TUI" press qa-race x >"$TMP/later.out" 2>"$TMP/later.err" && fail "press passed after a later capture failed"

# The program shows its first screen late, so a wait that does not poll reads
# it blank. The folder icon is U+F07B, and the tab must reach the screen as
# spaces.
cat > "$TMP/prog.sh" <<'EOF'
sleep 0.3
printf 'ready \357\201\273 %s\tend\n' "$1"
read -r line
printf '\033[2J\033[H'
echo "got $line"
sleep 0.5
exit 3
EOF

sh "$TUI" start qa-t 40 10 sh "$TMP/prog.sh" "it's here" || fail "start exited nonzero"

out="$(sh "$TUI" wait qa-t ready 5)" || fail "wait did not see ready: $out"
[ "$out" = "ready [U+F07B] it's here     end" ] || fail "unexpected screen: $out"
[ "$(sh "$TUI" show qa-t | wc -l)" -eq 1 ] || fail "show printed the blank rows below the text"

sh "$TUI" wait qa-t "not on screen" 1 >/dev/null 2>&1 && fail "wait passed on text that never showed"

sh "$TUI" gone qa-t ready 1 >/dev/null 2>&1 && fail "gone passed on text still on screen"

# A key that starts with a dash is text, not a tmux flag.
sh "$TUI" keys qa-t -hello Enter || fail "keys refused a key that starts with a dash"
out="$(sh "$TUI" wait qa-t "got -hello" 5)" || fail "wait did not see the answer: $out"
sh "$TUI" gone qa-t ready 5 >/dev/null || fail "gone did not see ready go"

sh "$TUI" wait qa-t "not on screen" 5 >/dev/null 2>&1 && fail "wait passed after the program exited"
[ "$(tmux display -p -t qa-t '#{pane_dead_status}')" = 3 ] || fail "the pane did not keep the exit status"

sh "$TUI" stop qa-t
tmux has-session -t qa-t 2>/dev/null && fail "stop left the session"

# A program such as a Bubble Tea app reads a key that follows Escape within a
# short window as Alt+key. Nothing may follow Escape within 0.1 seconds.
cat > "$TMP/raw.sh" <<'EOF'
stty -icanon -echo min 1 time 0
echo ready
dd bs=1 count=1 2>/dev/null > /dev/null
sleep 0.1
stty min 0 time 0
echo "after escape:$(dd bs=16 count=1 2>/dev/null)."
sleep 5
EOF
sh "$TUI" start qa-r 40 10 sh "$TMP/raw.sh"
sh "$TUI" wait qa-r ready 5 >/dev/null || fail "the raw program did not start"
sh "$TUI" keys qa-r Escape x
out="$(sh "$TUI" wait qa-r "after escape:" 5)" || fail "the raw program read nothing: $out"
[ "$out" = "ready
after escape:." ] || fail "Escape reached the program with the next key: $out"
sh "$TUI" stop qa-r

# tmux reads a ; at the end of an argument as its command separator, even
# after -l, so a SQL statement such as BEGIN; loses its ;.
sh "$TUI" start qa-s 40 10 sh -c 'echo ready; read -r line; echo "got $line"; sleep 5'
sh "$TUI" wait qa-s ready 5 >/dev/null || fail "the reading program did not start"
sh "$TUI" keys qa-s "BEGIN;" Enter || fail "keys refused a key that ends with ;"
out="$(sh "$TUI" wait qa-s "got BEGIN;" 5)" || fail "the trailing ; did not reach the program: $out"
sh "$TUI" stop qa-s

# -l sends the next argument as literal text, so text that reads as a key name
# reaches the program as typed.
sh "$TUI" start qa-l 40 10 sh -c 'echo ready; read -r line; echo "got $line"; sleep 5'
sh "$TUI" wait qa-l ready 5 >/dev/null || fail "the reading program did not start"
sh "$TUI" keys qa-l -l Enter -l "x;" Enter || fail "keys refused -l"
out="$(sh "$TUI" wait qa-l "got Enterx;" 5)" || fail "-l did not send its text literally: $out"
sh "$TUI" stop qa-l

# press types the keys, then prints the screen once it stops changing, so a
# redraw that lands a moment after the key is not read too early.
sh "$TUI" start qa-p 40 10 sh -c 'echo ready; read -r line; sleep 0.1; echo "got $line"; sleep 5'
sh "$TUI" wait qa-p ready 5 >/dev/null || fail "the reading program did not start"
out="$(sh "$TUI" press qa-p hi Enter)" || fail "press exited nonzero: $out"
case $out in *"got hi"*) ;; *) fail "press printed the screen before it settled: $out" ;; esac
sh "$TUI" stop qa-p

# A screen that never settles, such as a clock, makes press fail instead of hang.
sh "$TUI" start qa-c 40 10 sh -c 'i=0; while :; do i=$((i + 1)); echo "$i"; sleep 0.05; done'
sh "$TUI" press qa-c x >/dev/null 2>&1 && fail "press passed on a screen that never settled"
sh "$TUI" stop qa-c

# resize changes the window, then prints the screen once the program's late
# redraw has settled, so the step needs no sleep.
cat > "$TMP/size.sh" <<'EOF'
trap 'sleep 0.1; printf "\033[2J\033[H"; stty size' WINCH
stty size
while :; do sleep 0.05; done
EOF
sh "$TUI" start qa-z 40 10 sh "$TMP/size.sh"
sh "$TUI" wait qa-z "10 40" 5 >/dev/null || fail "the sizing program did not start"
out="$(sh "$TUI" resize qa-z 30 5)" || fail "resize exited nonzero: $out"
[ "$out" = "5 30" ] || fail "resize printed the screen before the redraw settled: $out"
sh "$TUI" stop qa-z

# colors prints each run of text with its foreground color, one run per line,
# and names an icon as show does.
cat > "$TMP/colors.sh" <<'EOF'
printf 'top\n\033[38;2;235;219;178mlit \357\201\273\033[0m plain \033[1;33mwarn\033[0m\n'
sleep 5
EOF
sh "$TUI" start qa-o 40 10 sh "$TMP/colors.sh"
sh "$TUI" wait qa-o warn 5 >/dev/null || fail "the colored program did not start"
out="$(sh "$TUI" colors qa-o)" || fail "colors exited nonzero: $out"
[ "$out" = '1 default "top"
2 #ebdbb2 "lit [U+F07B]"
2 default " plain "
2 c3+bold "warn"' ] || fail "unexpected colors: $out"
sh "$TUI" stop qa-o

echo "ok"
