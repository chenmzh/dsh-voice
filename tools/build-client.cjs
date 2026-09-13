const { buildSync } = require('esbuild');
const path = require('node:path');
buildSync({
  absWorkingDir: path.resolve(__dirname, '..'),
  entryPoints: ['lib/client/index.js'], bundle: true, platform: 'browser', format: 'cjs',
  target: 'es2022', charset: 'utf8', external: ['react', 'react/*', 'react-dom', 'react-dom/*', '@deepseek-ai/*'],
  banner: { js: 'window.__ModuleLoader__.load({id:"@nn12138/dsh-voice",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
  outfile: 'lib/client.js',
});
