#!/usr/bin/env node

import {scriptName} from 'yargs';

const yarg = scriptName('gitu')
  .usage('Universal git (https://cloudnativetoolkit.dev)')
  .usage('')
  .usage('Usage: $0 <command> [args]')
  .demandCommand()
  .commandDir('commands');

yarg.help()
  .argv;
