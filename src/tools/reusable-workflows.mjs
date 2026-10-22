/**
 * Reusable workflows, read from the repository that owns them.
 *
 * A repository that calls `uses: <org>/<repo>/.github/workflows/go-build.yml@<ref>` keeps the pin, the
 * setup and the gate flags in another repository. raw.githubusercontent.com answers 404 for a private
 * repository, so a review reading it that way concludes the file is unreachable. The harness holds a
 * credential that can read it, so it fetches the file and hands over the path.
 */

import fs from "node:fs";
import path from "node:path";

/** `acme/workflows/.github/workflows/go-build.yml` -> owner, repo, path. */
export function splitReusableTarget(workflow) {
  const parts = String(workflow ?? "").split("/");
  if (parts.length < 4) return null;
  return { owner: parts[0], repo: parts[1], filePath: parts.slice(2).join("/") };
}

export async function stageReusableWorkflows({ client, reusable, compareDir, log = () => {} }) {
  const staged = [];
  for (const entry of reusable ?? []) {
    const target = splitReusableTarget(entry.workflow);
    if (!target) {
      staged.push({ ...entry, path: null, note: "not a owner/repo/path form" });
      continue;
    }
    const local = path.join(compareDir, "reusable", `${target.owner}-${target.repo}@${entry.ref}`, path.basename(target.filePath));
    try {
      const text = await client.getFile(target.owner, target.repo, target.filePath, entry.ref);
      if (text == null) {
        staged.push({ ...entry, path: null, note: `${target.owner}/${target.repo}:${target.filePath}@${entry.ref} is not a file` });
        continue;
      }
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(local, text);
      staged.push({ ...entry, path: local, note: "" });
    } catch (error) {
      staged.push({ ...entry, path: null, note: `${error.message}` });
    }
  }
  const read = staged.filter((entry) => entry.path).length;
  if (staged.length) log(`reusable workflows: ${read} of ${staged.length} read from their own repository into the comparison root`);
  return staged;
}
