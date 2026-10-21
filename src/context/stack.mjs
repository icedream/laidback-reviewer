/**
 * Which PRs belong to one stack.
 *
 * A stacked PR's base is the branch of the PR under it, so walking `base.ref` upward off trunk gives
 * the chain. Context comes from the PR where the shared code was first read.
 */

export async function resolveStack({ client, owner, repo, pr, defaultBranch, maxDepth = 6, log = () => {} }) {
  const chain = [{ number: pr.number, headRef: pr.head.ref, baseRef: pr.base.ref }];
  let current = pr;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const baseRef = current.base?.ref;
    if (!baseRef || baseRef === defaultBranch) break;

    const below = await findPrForBranch({ client, owner, repo, branch: baseRef });
    if (!below) {
      // The base branch is not a PR: either trunk moved under the stack, or it is an integration
      // branch nobody opened a PR against. Either way the chain ends here.
      break;
    }
    chain.push({ number: below.number, headRef: below.head?.ref, baseRef: below.base?.ref });
    current = below;
  }

  const trunkAdjacent = chain.at(-1);
  const key = `${owner}/${repo}#${trunkAdjacent.number}`;
  if (chain.length > 1) log(`stack ${key}: ${chain.map((entry) => `#${entry.number}`).join(" <- ")}`);
  return { key, chain, siblings: chain.slice(1).map((entry) => entry.number) };
}

/** The open or closed PR whose head is `branch`, which is how a stack link is found. */
export async function findPrForBranch({ client, owner, repo, branch }) {
  const found = await client.listPullsForHead(owner, repo, branch);
  return found[0] ?? null;
}
