// Entry point that enables experimental SQLite
require('node:module').enableCompileCache?.();
process.env.NODE_OPTIONS = '--experimental-sqlite';
require('./server.js');