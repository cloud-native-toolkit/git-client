import {Arguments, Argv} from 'yargs';

export const command = 'pullRequest <command>'
export const aliases = ['pr']
export const desc = 'Commands to work with pull requests in the repo';
export const builder = (yargs: Argv<any>) => yargs.commandDir('pr_cmds')
export const handler =  async (argv: Arguments<any>) => {}
