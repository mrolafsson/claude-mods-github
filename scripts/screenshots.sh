#!/bin/sh
# Regenerates docs/images/*.png from the demo org, so no real pull request,
# repo or person can end up in the README.
#
# Starts Claude Code with this mod (and the Linear mod, for the link between
# them) in a hidden tmux window, opens `/github demo`, walks through the
# screens with key presses and captures each one; scripts/crop-pane.py cuts
# the pane out of the capture, and freeze turns it into a PNG. `/github`
# runs in the mod: no message reaches the model.
#
# Needs: tmux, freeze (brew install charmbracelet/tap/freeze), rsvg-convert
# with the JetBrains Mono font, python3; and Claude Code, signed in. The
# Linear mod is looked for beside this one (../claude-mods-linear), or at
# $LINEAR_MOD; without it the Linear screen is skipped.
set -eu
cd "$(dirname "$0")/.."
here=$PWD
linear=${LINEAR_MOD:-$here/../claude-mods-linear}

for tool in tmux freeze rsvg-convert python3 claude; do
	command -v "$tool" >/dev/null 2>&1 || { echo "screenshots need $tool" >&2; exit 1; }
done
if command -v fc-list >/dev/null 2>&1 && ! fc-list | grep -qi "JetBrains Mono"; then
	echo "screenshots need the JetBrains Mono font" >&2
	exit 1
fi
if command -v sips >/dev/null 2>&1; then
	shrink() { sips --resampleWidth 1800 "$1" >/dev/null; }
elif command -v magick >/dev/null 2>&1; then
	shrink() { magick "$1" -resize 1800x "$1"; }
else
	shrink() { :; }
fi

dirs="--plugin-dir '$here'"
names="mine filter pr merge review repos"
if [ -f "$linear/.claude-plugin/plugin.json" ]; then
	dirs="$dirs --plugin-dir '$linear'"
	names="$names linear"
fi

session=github-screenshots
screens=$(mktemp -d)
trap 'tmux kill-session -t "$session" 2>/dev/null || true; rm -rf "$screens"' EXIT

# Wide, so the pane docked beside the conversation gets room.
tmux kill-session -t "$session" 2>/dev/null || true
tmux new-session -d -s "$session" -x 200 -y 48 -c "$here" "claude $dirs"
sleep 10

keys() { tmux send-keys -t "$session" "$@"; sleep 1.5; }
snap() { sleep "${2:-3}"; tmux capture-pane -t "$session" -e -p >"$screens/$1.ansi"; }

# Typed as text, then Enter, so no keystroke is taken for a binding.
tmux send-keys -t "$session" -l "/github demo"
sleep 1.5
keys Enter
snap mine 5
tmux send-keys -t "$session" -l "sync"
snap filter
keys BSpace BSpace BSpace BSpace
# Down the list to #482, Ready to merge, and into it.
keys Down
keys Down
keys Down
keys Enter
snap pr 4
keys m
snap merge
keys Escape
if [ -f "$linear/.claude-plugin/plugin.json" ]; then
	# Its Linear issue, in the Linear mod's pane; Esc comes back.
	keys l
	snap linear 4
	keys Escape
	sleep 2
fi
# Back to the list, on #482: up past #479 and #118 to the filter, where ↑
# switches tabs.
keys Escape
sleep 2
keys Up
keys Up
keys Up
keys Up
snap review
# On to the repo tab and its ⇄: Enter there opens the repo picker.
keys Up
keys Up
keys Enter
snap repos

mkdir -p docs/images
for name in $names; do
	python3 scripts/crop-pane.py <"$screens/$name.ansi" >"$screens/$name.pane"
	freeze --language ansi --window \
		--font.family "JetBrains Mono" --font.size 14 --line-height 1.3 \
		--padding 20,24 --margin 0 --border.radius 10 \
		--background "#1e1e2e" --output "docs/images/$name.png" <"$screens/$name.pane" >/dev/null
	shrink "docs/images/$name.png"
	echo "docs/images/$name.png"
done
