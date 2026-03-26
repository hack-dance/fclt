Output Ghostty.gif

Set Shell "zsh"
Set FontSize 24
Set Width 1100
Set Height 760
Set Padding 24
Set TypingSpeed 35ms
Set Theme "Catppuccin Frappe"

Env HOME "/tmp/demo/home"
Env XDG_STATE_HOME "/tmp/demo/state"
Env XDG_CACHE_HOME "/tmp/demo/cache"
Env FACULT_ROOT_DIR "/tmp/demo/home/.ai"
Env PATH "/tmp/demo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
Env PS1 "fclt-demo $ "

Hide
Type "./scripts/demo/setup-safe-demo.sh /tmp/demo"
Enter
Type "cd /tmp/demo/repo"
Enter
Type "export HOME=/tmp/demo/home"
Enter
Type "export XDG_STATE_HOME=/tmp/demo/state"
Enter
Type "export XDG_CACHE_HOME=/tmp/demo/cache"
Enter
Type "export FACULT_ROOT_DIR=/tmp/demo/home/.ai"
Enter
Type "export PATH=/tmp/demo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
Enter
Type "export PS1='fclt-demo $ '"
Enter
Type "export PROMPT='fclt-demo $ '"
Enter
Type "fclt templates init agent demo-reviewer >/dev/null"
Enter
Type "mkdir -p .codex"
Enter
Type "echo 'eyJtY3BTZXJ2ZXJzIjp7ImdpdGh1YiI6eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtb2RlbGNvbnRleHRwcm90b2NvbC9zZXJ2ZXItZ2l0aHViIl0sImVudiI6eyJHSVRIVUJfUEVSU09OQUxfQUNDRVNTX1RPS0VOIjoiZ2hwX2RlbW9faW5saW5lX3NlY3JldCJ9fX19' | base64 -d > .codex/mcp.json"
Enter
Type "fclt index >/dev/null"
Enter
Type "clear"
Enter
Show

Type "fclt scan --from . --no-config-from"
Enter
Sleep 4s

Type "clear"
Enter
Type "fclt audit --non-interactive --from . --severity high"
Enter
Sleep 4s

Type "clear"
Enter
Type "fclt templates list"
Enter
Sleep 3s

Type "clear"
Enter
Type "fclt list agents"
Enter
Sleep 3s
