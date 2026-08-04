# Commands

Usage examples for every CLI flag. The flag reference table lives in the
[README](../README.md#commands).

## Quick start

```bash
# OpenRouter (default)
communicator                                            # full interactive flow
communicator -m "openai/gpt-4o" "Hello there"           # one-shot chat with a fixed model
communicator --list-models                                       # list OpenRouter models
communicator --list-endpoints "anthropic/claude-sonnet-4-20250514"  # list endpoints for a model
communicator --list-endpoints "inkling-small"                       # fuzzy match: unique partial IDs work
communicator --list-endpoints                                       # no arg: interactive model picker

# Venice.ai
communicator -p venice                                  # Venice interactive flow
communicator -p venice -m "qwen-3-7-max" "Hello"        # one-shot chat with a fixed model
communicator -p venice --list-models                             # list Venice models (no API key needed)
communicator -p venice --list-endpoints "qwen-3-7-max"           # show Venice endpoint info

# One-shot mode (non-interactive, no chat loop)
communicator -m "openai/gpt-4o" "What is the capital of France?"     # positional prompt
echo "Summarize this: ..." | communicator -m "openai/gpt-4o"          # piped stdin
communicator -m "openai/gpt-4o" --temperature 0.2 "Write a haiku"     # with temperature
cat notes.md | communicator -m "openai/gpt-4o" --budget 0.5 "Fix typos:" # with budget cap
communicator -m "openai/gpt-4o" --attach screenshot.png "What is the bug?"   # vision model + image
communicator -p venice -m "qwen-3-7-max" --attach data.xlsx "Summarize this" # Venice office file

# Session management
communicator --list-sessions                                   # list saved sessions
communicator --resume                                   # resume a saved session
communicator --export                                   # export a session to cwd
communicator --export --output-dir ~/Documents          # export to custom directory
communicator --delete                                   # delete a session (with confirmation)
communicator --delete 2026-07-30T19-11-45               # delete a specific session

# Reasoning (one-shot session, or use -m alone to save the default)
communicator -m "deepseek/deepseek-v4-flash" --reasoning-effort high "Solve this"   # force high reasoning effort
communicator -m "deepseek/deepseek-v4-flash" --reasoning-effort none                # disable reasoning
communicator -p venice -m "deepseek-v4-flash" --reasoning-effort high "Solve this"  # Venice with reasoning

# Web search (one-shot session; standalone use saves the default)
communicator -m "openai/gpt-4o" --web-search auto "Latest AI news"      # auto mode: the model decides when to search
communicator -m "openai/gpt-4o" --web-search always "Latest AI news"    # force a web search on every request
communicator -m "openai/gpt-4o" --web-search off "Latest AI news"       # disable web search
communicator -m "openai/gpt-4o" --web-results 5 "Latest AI news"        # 5 results, implies auto mode
communicator -p venice -m "qwen-3-7-max" --web-search "Latest AI news"  # Venice: no result count; always maps to on

# Standalone config commands (persist defaults to ~/.communicator.json and exit)
communicator --output-dir ~/Documents                                  # save the default export directory
communicator --config                                                  # print the current config
communicator -m "deepseek/deepseek-v4-flash"                           # validate a model, show its details, set it as default
communicator -m "deepseek/deepseek-v4-flash" --temperature 0.5         # set per-model temperature default
communicator -m "deepseek/deepseek-v4-flash" --reasoning-effort high   # set per-model reasoning default
communicator -m "deepseek/deepseek-v4-flash" --web-search always       # set per-model web search default
communicator --budget 2                                                # set the default budget cap for sessions
communicator --web-results 5                                           # set the default result count (OpenRouter only)
communicator --smooth-speed fast                                       # set the default smooth streaming speed
communicator --no-smooth-streaming                                     # disable smooth streaming by default
```

In-chat slash commands (`/model`, `/temp`, `/budget`, `/attach`, …) are
documented in the [README](../README.md#slash-commands), including the Tab /
Shift+Tab command-suggestion behavior.
