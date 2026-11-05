import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadConfig } from '../apps/server/dist/config.js';
import { openRuntime } from '../apps/server/dist/runtime.js';
import { SkillService } from '../apps/server/dist/services/skills.js';
import { gitReader } from '../apps/server/dist/skills/git.js';
import { gitImportSchema } from '../packages/shared/dist/index.js';

const input = gitImportSchema.parse({
  repository: process.argv[2] ?? 'https://github.com/obra/superpowers.git',
  subdir: process.argv[3] ?? 'skills/brainstorming',
});
const root = await mkdtemp(resolve(tmpdir(), 'lingma-git-smoke-'));
let runtime;
let skills;
try {
  runtime = await openRuntime(loadConfig({ DATA_DIR: 'data' }, root));
  skills = new SkillService(
    runtime.db,
    runtime.blobs,
    runtime.gate,
    gitReader(runtime.directories.temp),
  );
  const job = skills.importGit(input);
  await skills.idle();
  const completed = skills.job(job.id);
  assert.equal(completed.status, 'completed', completed.error ?? 'Git import did not complete');
  const original = skills.detail(completed.skillId);
  assert.match(original.version.sourceSnapshot.commit, /^[a-f0-9]{40}$/);
  assert.equal(original.version.sourceSnapshot.subdir, input.subdir);
  for (const file of original.version.files) {
    const read = await skills.file(original.skill.id, original.version.id, file.relativePath);
    assert.equal(read.bytes.byteLength, file.sizeBytes);
  }
  const edited = await skills.save(
    original.skill.id,
    original.version.id,
    '# Synthetic local edit for smoke verification',
  );
  const update = skills.updateGit(original.skill.id, edited.version.id);
  await skills.idle();
  assert.equal(
    skills.job(update.id).status,
    'completed',
    skills.job(update.id).error ?? 'Source update failed',
  );
  const latest = skills.detail(original.skill.id);
  assert.equal(latest.version.versionNo, 3);
  assert.deepEqual(skills.snapshot(original.version.id), original.version);
  assert.equal(
    skills.snapshot(edited.version.id).entryContent,
    '# Synthetic local edit for smoke verification',
  );
  console.log(
    JSON.stringify(
      {
        repository: input.repository,
        subdir: input.subdir,
        importedCommit: original.version.sourceSnapshot.commit,
        updatedCommit: latest.version.sourceSnapshot.commit,
        files: original.version.files.length,
        versions: latest.version.versionNo,
        result: 'Public Git import, scoped attachments, manual edit and explicit update verified.',
      },
      null,
      2,
    ),
  );
} finally {
  await skills?.close();
  await runtime?.close();
  await rm(root, { recursive: true, force: true });
}
