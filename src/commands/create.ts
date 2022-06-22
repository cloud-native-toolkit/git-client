import {Arguments, Argv} from 'yargs';
import {apiFromPartialConfig, apiFromUrl, GitApi, isGitError} from '../lib';
import {
  defaultOwnerToUsername,
  loadCredentialsFromFile,
  loadFromEnv,
  parseHostAndOrgFromUrl
} from './support/middleware';
import {forCredentials} from './support/checks';

const defaultToPrivateRepo = () => {
  return yargs => {
    if (!yargs.publicRepo && !yargs.privateRepo) {
      return {privateRepo: true}
    }

    return {}
  }
}

export const command = 'create [name]'
export const aliases = []
export const desc = 'Creates a hosted git repo';
export const builder = (yargs: Argv<any>) => yargs
  .positional('name', {
    type: 'string',
    description: 'The name of the repo that will be created',
    demandOption: true
  })
  .option('autoInit', {
    type: 'boolean',
    description: 'Flag indicating the repository should be initialized with a simple README when it is created',
    default: true
  })
  .option('privateRepo', {
    type: 'boolean',
    alias: ['private'],
    description: 'Flag indicating the repository should be private. Mutually exclusive with `publicRepo` flag.',
    conflicts: 'publicRepo'
  })
  .option('publicRepo', {
    type: 'boolean',
    alias: ['public'],
    description: 'Flag indicating the repository should be public. Mutually exclusive with `privateRepo` flag.',
    conflicts: 'privateRepo'
  })
  .option('gitUrl', {
    type: 'string',
    alias: ['g'],
    description: 'The git url of the org or another repo in the same org. Either gitUrl OR host and owner must be provided.'
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
    description: 'The username used to create the git repository. The value can also be provided via the `GIT_USERNAME` environment variable.'
  })
  .option('token', {
    type: 'string',
    description: 'The token/password used to authenticate the user to the git server. The value can also be provided via the GIT_TOKEN environment variable.',
  })
  .options('debug', {
    type: 'boolean',
    description: 'Display debug information'
  })
  .middleware(parseHostAndOrgFromUrl(), true)
  .middleware(loadFromEnv('host', 'GIT_HOST'), true)
  .middleware(loadFromEnv('username', 'GIT_USERNAME'), true)
  .middleware(loadFromEnv('token', 'GIT_TOKEN'), true)
  .middleware(loadCredentialsFromFile(), true)
  .middleware(defaultOwnerToUsername(), true)
  .middleware(defaultToPrivateRepo(), true)
  .check(forCredentials())
export const handler =  async (argv: Arguments<CreateArgs & {debug: boolean}>) => {

  const credentials = {username: argv.username, password: argv.token}

  try {
    const orgApi: GitApi = argv.gitUrl
      ? await apiFromUrl(argv.gitUrl, credentials)
      : await apiFromPartialConfig({host: argv.host, org: argv.owner}, credentials)

    const type = orgApi.getConfig().type
    const owner = orgApi.getConfig().owner
    console.log(`Creating ${type} repo: ${owner}/${argv.name}`)

    const repoApi: GitApi = await orgApi.createRepo({
      name: argv.name,
      autoInit: argv.autoInit,
      privateRepo: argv.privateRepo
    })

    console.log(`  Repo created: ${repoApi.getConfig().url}`)
  } catch (err) {
    if (isGitError(err)) {
      console.error(err.message)
    } else if (argv.debug) {
      console.error('Error creating repo', err)
    } else {
      console.error('Error creating repo')
    }
    process.exit(1)
  }
}

interface CreateArgs {
  name: string;
  gitUrl?: string;
  host?: string;
  owner?: string;
  username: string;
  token: string;
  autoInit?: boolean;
  privateRepo?: boolean
}
