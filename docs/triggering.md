# Which PRs trigger it

Repositories are settled first. `github.orgs` lists owners, `github.repos` lists `owner/name`
patterns where `*` covers one path segment and `?` one character, and `github.deny` outranks both:

```yaml
github:
  orgs: [example-corp]
  repos: [other-org/runbook]
  deny: [example-corp/secret-*]
```

Names are compared without regard to case, as GitHub resolves them, so a lowercase pattern admits the
display casing the API reports. Everything downstream, including the store key, keeps the casing from
the search hit rather than the one you wrote.

With both allow lists empty the bot reviews nothing, which is the default worth having for a bot that
posts from your own account. `orgs: ["*"]` is the wide setting that takes every repository the token
sees. The filter runs on the search result, before `GET /pulls/N`, so an ignored repository costs one
search hit, no pull fetch and no model time, and the cycle log says why: `skip … matches github.deny
"example-corp/secret-*"`.

The trigger is an individual review request (`review-requested:<you>`), not an assignment. GitHub keeps
the two apart in its data: a request to you appears in `requested_reviewers`, a request to a team you
belong to appears in `requested_teams`, and the timeline event carries `requested_reviewer` or
`requested_team`. No team membership has to be guessed, and `trigger.mode` sets how wide the net is:

- `review_requested` (default): only PRs where you are a named reviewer. Being an assignee too changes
  nothing, and a team-only request is never picked up.
- `assigned`: the older behaviour, `assignee:<you>`, which GitHub also fills from CODEOWNERS.
- `both`: either query, and a PR found by both is reviewed once, on the request.

Provenance is a second axis. The API reports who set the trigger, not why, so `trigger.policy` is a
choice:

- `any` (default): act on it whoever set it.
- `human_actor`: eligible when a person filed the request, whoever wrote the PR; asking yourself
  counts. Skipped only when every request event came from a bot or an organization.
- `exclude_codeowners`: best effort; skip when the trigger landed within five minutes of PR creation
  and a CODEOWNERS rule covering the changed paths names you. Both halves must hold.

The section used to be called `assignment:`. That spelling is still read, translated into `trigger:`,
and named in the startup log rather than dropped.

Dedupe is per `(owner, repo, pr, head_sha)`, so a force push is a new candidate. A review requested
again on the same head reopens it when `reviews.respondToReRequest` is on, up to
`reviews.maxReReviewsPerHead` times per head, and the task prompt then says plainly that this is a
re-review so the model reports what changed instead of repeating itself.

The search carries `is:open`, so a pull request that merges or closes stops being a candidate at once, and
any [task gate](gate.md) still waiting on that head is settled rather than left unanswered.
