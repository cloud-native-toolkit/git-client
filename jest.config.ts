import type {Config} from '@jest/types';

// Sync object
const config: Config.InitialOptions = {
  verbose: true,
  testPathIgnorePatterns: [
    "/node_modules/",
    "/dist/"
  ],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
};

export default config;
