import {apiFromUrl, SimpleGitWithApi} from './lib';
import {SimpleGit} from 'simple-git';
import first from './util/first';
import {addKustomizeResource} from './kustomization.model';
import * as fs from 'fs';
import * as path from 'path';

if (process.argv.length < 5) {
  throw new Error('Usage: GIT_USER={user} GIT_TOKEN={token} test-rebase {url} {sourceBranch} {targetBranch}');
}

const input = {
  url: process.argv[2],
  sourceBranch: process.argv[3],
  targetBranch: process.argv[4],
}

const argocdResolver = (applicationPath: string) => {
  return async (git: SimpleGitWithApi, conflicts: string[]): Promise<{resolvedConflicts: string[]}> => {
    const kustomizeYamls: string[] = conflicts.filter(f => /.*kustomization.yaml/.test(f));

    const resolvedConflicts: string[] = await Promise.all(kustomizeYamls.map(async (kustomizeYaml: string) => {
      await git.raw(['checkout', '--ours', kustomizeYaml]);

      await addKustomizeResource(path.join(git.repoDir, kustomizeYaml), applicationPath);

      return kustomizeYaml;
    }));

    return {resolvedConflicts};
  }
}

const testRebase = async ({url, sourceBranch, targetBranch}: {url: string, sourceBranch: string, targetBranch: string}) => {
  const api = await apiFromUrl(url, {username: process.env.GIT_USER, password: process.env.GIT_TOKEN});

  const result = await api.rebaseBranch({sourceBranch, targetBranch, resolver: argocdResolver('test')});

  return result;
}

testRebase(input)
  .then((result: boolean) => console.log('Branch changed: ' + result))
  .catch(err => console.error(err));
