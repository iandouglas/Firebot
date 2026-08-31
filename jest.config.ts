/**
 * For a detailed explanation regarding each configuration property, visit:
 * https://jestjs.io/docs/configuration
 */

import type {Config} from 'jest';

const config: Config = {
    // Jest can't parse TypeScript natively, so all .ts files are compiled with ts-jest
    // using tsconfig.test.json.
    transform: {
        '^.+\\.tsx?$': ['ts-jest', {
            tsconfig: 'tsconfig.test.json',
            isolatedModules: false,
            diagnostics: true
        }]
    },

    // Backend singletons import the electron main process (e.g. ipcMain), which
    // doesn't exist under jest. Tests get a stub instead.
    moduleNameMapper: {
        '^electron$': '<rootDir>/tests/mocks/electron-mock.ts'
    },

    // Automatically clear mock calls, instances, contexts and results before every test
    clearMocks: true,

    // Indicates which provider should be used to instrument code for coverage
    coverageProvider: "v8",
};

export default config;