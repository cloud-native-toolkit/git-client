import {Arguments, Argv} from 'yargs';
import {apiFromUrl, GitApi, isGitError} from '../lib';

const loadFromEnv = (name: string, envName: string) => {
  return yargs => {
    const result = {}

    if (!yargs[name]) {
      result[name] = process.env[envName]
    }

    return result
  }
}

export const command = 'delete [gitUrl]'
export const desc = 'Deletes a hosted git repo';
export const builder = (yargs: Argv<any>) => yargs
  .positional('gitUrl', {
    type: 'string',
    description: 'The git url of the git repository that will be deleted',
    demandOption: true
  })
  .option('host', {
    type: 'string',
    alias: ['h'],
    description: 'The host of the git server for the repo. The value can be provided as a `GIT_HOST` environment variable.'
  })
  .option('owner', {
    type: 'string',
    alias: ['o'],
    description: 'The owner/org for the git repo on the git server. If not provided the value will default to the `username` value.'
  })
  .option('username', {
    type: 'string',
    alias: ['u'],
    description: 'The username used to create the git repository. The value can also be provided via the `GIT_USERNAME` environment variable.',
  })
  .option('token', {
    type: 'string',
    description: 'The token/password used to authenticate the user to the git server. The value can also be provided via the GIT_TOKEN environment variable.',
  })
  .options('debug', {
    type: 'boolean',
    description: 'Display debug information'
  })
  .middleware(loadFromEnv('host', 'GIT_HOST'))
  .middleware(loadFromEnv('username', 'GIT_USERNAME'))
  .middleware(loadFromEnv('token', 'GIT_TOKEN'))
  .middleware(yargs => {
    if (!yargs.owner) {
      return {owner: yargs.username}
    }

    return {}
  })
  .middleware(yargs => {
    if (!/^https?/.test(yargs.gitUrl) && ~/^git@/.test(yargs.gitUrl) && !!yargs.host) {
      return {gitUrl: `https://${yargs.host}/${yargs.owner}/${yargs.gitUrl}`}
    }

    return {}
  })
  .check(yargs => {
    if (!yargs.username) {
      throw new Error('Git username is required. The value can be provided in the `username` argument or `GIT_USERNAME` environment variable')
    }
    if (!yargs.token) {
      throw new Error('Git token is required. The value can be provided in the `token` argument or `GIT_TOKEN` environment variable')
    }

    return true
  })
export const handler =  async (argv: Arguments<DeleteArgs & {debug: boolean}>) => {

  const credentials = {username: argv.username, password: argv.token}

  try {
    const repoApi: GitApi = await apiFromUrl(argv.gitUrl, credentials)
    console.log(`Deleting repo: ${argv.gitUrl}`)

    await repoApi.deleteRepo()

    console.log(`  Repo deleted: ${argv.gitUrl}`)
  } catch (err) {
    if (isGitError(err)) {
      console.error(err.message)
    } else if (argv.debug) {
      console.error('Error deleting repo', err)
    } else {
      console.error('Error deleting repo')
    }
    process.exit(1)
  }
}

interface DeleteArgs {
  gitUrl: string;
  username: string;
  token: string;
  host?: string;
  owner?: string;
}
