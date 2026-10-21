/**
 * Does the credential match the ceiling the bot assumes?
 *
 * The bot is built on a fine-grained PAT with Contents: read-only, and a fine-grained token cannot
 * be introspected: `X-OAuth-Scopes` is empty for it. So the only honest check is to attempt the
 * write and read the answer.
 *
 * The attempt cannot create anything. `sha` is the base blob sha the update would apply to, and
 * 40 zeros is not an object in any repository, so a token that can write contents answers 422
 * (invalid sha) and a read-only token answers 403 (forbidden). Both refuse before touching a ref,
 * and no file is written either way.
 */

const PROBE_PATH = ".laidback-reviewer-probe";
const NOT_AN_OBJECT_SHA = "0".repeat(40);

/**
 * @param client GitHub client
 * @param repo "owner/name" the probe runs against; must be visible to the token
 * @returns verdict: read_only (ceiling holds), can_write (it does not), unknown (proves nothing)
 */
export async function probeContentsReadOnly({ client, repo, log = () => {} }) {
  const [owner, ...rest] = String(repo).split("/");
  const name = rest.join("/");
  if (!owner || !name) return { verdict: "unknown", detail: `probeRepo "${repo}" is not owner/name` };

  let error;
  try {
    await client.putContents(owner, name, PROBE_PATH, {
      message: "laidback-reviewer token scope probe (expected to fail)",
      content: Buffer.from("probe\n").toString("base64"),
      sha: NOT_AN_OBJECT_SHA,
    });
    // Nothing should reach here: the sha is invalid. If it ever does, the credential can write.
    return { verdict: "can_write", detail: `${owner}/${name}: a contents write unexpectedly succeeded` };
  } catch (caught) {
    error = caught;
  }

  const status = error?.status;
  if (status === 403) return { verdict: "read_only", detail: `${owner}/${name}: contents write refused (403)` };
  if (status === 422) return { verdict: "can_write", detail: `${owner}/${name}: contents write accepted up to validation (422)` };
  if (status === 404) return { verdict: "unknown", detail: `${owner}/${name} is not visible to this token (404)` };
  if (status === 401) return { verdict: "unknown", detail: "the token was rejected (401)" };
  return { verdict: "unknown", detail: `${owner}/${name}: ${error?.message ?? error}` };
}
