#!/usr/bin/env node
// The published entry point (`npx claude-fleet <cmd>`). It exists only to turn main()'s returned
// number into an exit code: main() itself never exits, because it is also called in-process.

import process from 'node:process'
import { main } from '../src/cli.mjs'

// `process.exitCode` rather than `process.exit()`: exit() truncates a pending stdout write on a
// pipe, and the one JSON object the launcher parses is exactly that write.
process.exitCode = await main(process.argv.slice(2))
