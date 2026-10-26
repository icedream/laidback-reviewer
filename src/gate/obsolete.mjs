/**
 * A task gate whose pull request moved on.
 *
 * Discovery searches open pull requests only, so a task gate cannot be consumed once its pull request
 * merges: the head is never a candidate again, the row stays `approved`, and the channel keeps showing a
 * decision that nothing acts on. An approval tapped minutes after the author merged reads as a hang.
 *
 * This walks the task gates the loop still owes a pass to and settles the ones with no pass left to run.
 * Post gates are deliberately not touched: the review is already composed, and GitHub takes a review on a
 * merged pull request, so an approval there still means something.
 */

export const WITHDRAWN = "withdrawn";

/** Minute precision is enough to say when the pull request stopped being reviewable. */
const stamp = (iso) => (iso ? `${String(iso).slice(0, 16).replace("T", " ")}Z` : "unknown time");

function reasonFor({ pr, status }) {
  // A 404 is the pull request being gone; a readable-but-unexpected payload says nothing, so it is
  // reported as its own case rather than guessed at.
  if (!pr) return `pull request is gone (${status}), nothing left to review`;
  if (pr.merged_at) return `pull request merged at ${stamp(pr.merged_at)}, before the pass could run`;
  return `pull request closed at ${stamp(pr.closed_at)}, before the pass could run`;
}

/**
 * @returns how many gates were settled, so a cycle can say so once rather than per gate.
 */
export async function withdrawClosedPullGates({ store, client, transport = null, log = () => {} }) {
  let settled = 0;
  for (const gate of store.awaitingTaskGates()) {
    let pr = null;
    let goneStatus = 0;
    try {
      pr = await client.getPull(gate.owner, gate.repo, gate.pr);
    } catch (error) {
      // Only a 404 is terminal. A timeout or a rate limit says nothing about the pull request, and
      // settling a gate on one would drop a review the author is still waiting for.
      if (error?.status !== 404) {
        log(`gate ${gate.id}: ${gate.owner}/${gate.repo}#${gate.pr} could not be read (${error.message}); it stays ${gate.state}`);
        continue;
      }
      goneStatus = 404;
    }
    if (pr && !pr.merged_at && pr.state === "open") continue;

    const reason = reasonFor({ pr, status: goneStatus });
    const settledGate = store.decideGate({ id: gate.id, state: WITHDRAWN, decided_by: "harness", reason });
    settled += 1;
    log(`gate ${gate.id} ${WITHDRAWN}: ${reason}`);

    // The message is what looks stuck, so the store alone is not enough. Editing it in place beats a fresh
    // notification for something the reader is already looking at, and a channel that cannot edit falls
    // back to one line of its own.
    try {
      if (transport?.redraw) await transport.redraw(settledGate);
      else if (transport?.notify) await transport.notify(`gate ${gate.id} ${WITHDRAWN}: ${reason}`);
    } catch (error) {
      log(`gate ${gate.id} settled in the store, but its channel message could not be rewritten: ${error.message}`);
    }
  }
  return settled;
}
