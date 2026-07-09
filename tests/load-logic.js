// Loads Logic.gs (which is plain JS in a .gs extension) into a Node module.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'Logic.gs'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', src)(mod, mod.exports);
module.exports = mod.exports;
