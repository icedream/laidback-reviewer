# Review agent definitions

`agent.agentDir` in config.yaml points here, and `agent.name` selects `<name>.md`.

The bot reuses the same agent file the interactive `pr-review` subagent uses, so both follow one
standard. That file belongs to the skills repository, not to this one:

```bash
cp ~/.pi/agent/agents/pr-review.md .pi/agent/agents/
```

Copy it rather than symlink it: in the container the agent file has to be a pinned artifact you can
read before a run, and the skills it cites arrive on the read-only `/skills` mount
(`agent.skillsDir: /skills`).

`prompt_mode: replace` uses the file body as the system prompt and re-adds the skill listing that
replacing the prompt would otherwise lose. `prompt_mode: append` keeps pi's default prompt and adds
the agent text to it.
