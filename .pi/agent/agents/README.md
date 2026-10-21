# Review agent definitions

`agent.agentDir` in config.yaml points at the directory holding the review agent, and `agent.name`
selects `<name>.md`. Either may come from the environment instead, `LAIDBACK_AGENT_DIR` and
`LAIDBACK_AGENT_NAME`, and the directory may start with `~`. A machine that keeps its review standard
somewhere else therefore needs no entry in this repository at all.

Nothing in this directory is tracked except this README. The agent text carries one workplace's review
conventions, so it lives in the skills checkout rather than in this repository.

Two ways to make it available:

```bash
# host run: point at the directory and file as they are on this machine
LAIDBACK_AGENT_DIR="$HOME/.pi/agent/agents" LAIDBACK_AGENT_NAME=<file name> \
  node src/cli/review-once.mjs --repo <owner>/<name> --pr <n>
```

For the container, bind that directory read-only and set the same variable to its in-container path, or
copy the file into this directory when you want a pinned artifact to read before a run.

`prompt_mode: replace` uses the file body as the system prompt and re-adds the skill listing that
replacing the prompt would otherwise lose. `prompt_mode: append` keeps pi's default prompt and adds the
agent text to it. The skills the agent cites arrive on the read-only `/skills` mount
(`agent.skillsDir: /skills`).
