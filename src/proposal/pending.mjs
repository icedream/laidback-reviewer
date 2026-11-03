/**
 * Reviews GitHub is holding unsubmitted.
 *
 * A pending review is pinned to the commit it was composed against. When the author pushes, its anchors
 * go stale while the review itself stays, because only the operator can submit or delete it in the UI.
 * This reads the two facts that matter once a cycle and speaks up the first time one of them changes;
 * it never submits, edits or deletes anything.
 */

/**
 * @param store    the state store
 * @param client   the read side of the GitHub client
 * @param notify   optional async (text) to the gate channel
 * @returns one entry per row that changed state, for logs and tests
 */
export async function sweepPendingPosts({ store, client, notify = null, log = () => {} }) {
  const rows = store.pendingPosts();
  if (!rows.length) return [];

  const changed = [];
  for (const row of rows) {
    let review;
    let headSha;
    try {
      // GitHub does not list a pending review to anyone but its author, so a row that is still absent
      // from the list is read as still waiting rather than as gone.
      [review, headSha] = [
        (await client.listReviews(row.owner, row.repo, row.pr)).find((entry) => String(entry.id) === String(row.github_review_id)),
        (await client.getPull(row.owner, row.repo, row.pr))?.head?.sha,
      ];
    } catch (error) {
      log(`pending review ${row.github_review_id}: ${error.message}`);
      continue;
    }

    if (review && review.state !== "PENDING") {
      store.setPostState({ id: row.id, state: "submitted" });
      log(`the unsubmitted review ${row.github_review_id} on ${row.owner}/${row.repo}#${row.pr} was submitted by the operator as ${review.state}`);
      changed.push({ id: row.id, state: "submitted", reviewState: review.state });
      continue;
    }

    if (headSha && headSha !== row.head_sha) {
      store.setPostState({ id: row.id, state: "pending_stale" });
      const text = `${row.owner}/${row.repo}#${row.pr} still holds an unsubmitted review at ${row.head_sha.slice(0, 8)}; the head is now ${headSha.slice(0, 8)}, so its comment anchors are out of date.`;
      log(text);
      if (notify) {
        try {
          await notify(text);
        } catch (error) {
          log(`that warning could not reach the gate channel: ${error.message}`);
        }
      }
      changed.push({ id: row.id, state: "pending_stale", headSha });
    }
  }
  return changed;
}
