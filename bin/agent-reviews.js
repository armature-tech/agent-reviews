#!/usr/bin/env node
'use strict';

const { main } = require('../lib/cli');

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
