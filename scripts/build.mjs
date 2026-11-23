// Build script: bundles the extension with esbuild and copies static assets.
//   node scripts/build.mjs          -> dist/       (production build)
//   node scripts/build.mjs --test   -> dist-test/  (adds localhost matches + mock providers for E2E tests)
//   node scripts/build.mjs --watch  -> rebuild on change
import * as esbuild from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST = process.argv.includes('--test');
const WATCH = process.argv.includes('--watch');
const outdir = path.join(root, TEST ? 'dist-test' : 'dist');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

const SITE_MATCHES = [
  'https://www.netflix.com/*',
  'https://www.youtube.com/*',
  'https://m.youtube.com/*',
  'https://www.disneyplus.com/*',
  'https://www.primevideo.com/*',
  ...['com', 'co.uk', 'de', 'co.jp', 'es', 'fr', 'it', 'ca', 'com.mx', 'com.br', 'in', 'com.au'].map(
    (tld) => `https://www.amazon.${tld}/gp/video/*`,
  ),
];
const TEST_MATCHES = ['http://localhost/*', 'http://127.0.0.1/*'];

async function buildManifest() {
  const manifest = JSON.parse(await readFile(path.join(root, 'src/manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  const matches = TEST ? [...SITE_MATCHES, ...TEST_MATCHES] : SITE_MATCHES;
  manifest.content_scripts = [
    { matches, js: ['content-main.js'], run_at: 'document_start', world: 'MAIN', all_frames: false },
    { matches, js: ['content.js'], run_at: 'document_start', all_frames: false },
  ];
  if (TEST) {
    manifest.name = 'Vidioma (test build)';
    manifest.host_permissions.push(...TEST_MATCHES);
  }
  await writeFile(path.join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

async function copyStatic() {
  const copies = [
    ['src/_locales', '_locales'],
    ['src/icons', 'icons'],
    ['src/offscreen/offscreen.html', 'offscreen.html'],
    ['src/offscreen/pcm-worklet.js', 'pcm-worklet.js'],
    ['node_modules/kuromoji/dict', 'dict'],
    ['node_modules/sql.js/dist/sql-wasm-browser.wasm', 'vendor/sql-wasm-browser.wasm'],
  ];
  for (const page of await readdir(path.join(root, 'src/pages'))) {
    for (const ext of ['html', 'css']) {
      const f = `src/pages/${page}/${page}.${ext}`;
      if (existsSync(path.join(root, f))) copies.push([f, `pages/${page}.${ext}`]);
    }
  }
  copies.push(['src/pages/common.css', 'pages/common.css']);
  for (const [from, to] of copies) {
    const src = path.join(root, from);
    if (!existsSync(src)) continue;
    await mkdir(path.dirname(path.join(outdir, to)), { recursive: true });
    await cp(src, path.join(outdir, to), { recursive: true });
  }
}

// Some dependencies (kuromoji, sql.js) reference Node built-ins; give them browser stand-ins.
const nodeShims = {
  name: 'node-shims',
  setup(build) {
    build.onResolve({ filter: /^(node:)?(path|fs|crypto)$/ }, (args) => ({
      path: path.join(root, 'src/shims', args.path.replace('node:', '') === 'path' ? 'path.ts' : 'empty.ts'),
    }));
  },
};

const common = {
  bundle: true,
  minify: !TEST,
  sourcemap: TEST ? 'inline' : false,
  target: ['chrome116'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.css': 'text' },
  define: {
    __TEST__: JSON.stringify(TEST),
    'process.env.NODE_ENV': JSON.stringify(TEST ? 'development' : 'production'),
  },
  logLevel: 'warning',
  legalComments: 'none',
  plugins: [nodeShims],
};

const builds = [
  { entryPoints: { background: 'src/background/index.ts' }, format: 'esm' },
  { entryPoints: { 'content-main': 'src/content/main-world.ts' }, format: 'iife' },
  { entryPoints: { content: 'src/content/index.ts' }, format: 'iife' },
  { entryPoints: { offscreen: 'src/offscreen/offscreen.ts' }, format: 'iife' },
  {
    entryPoints: {
      'pages/popup': 'src/pages/popup/popup.tsx',
      'pages/options': 'src/pages/options/options.tsx',
      'pages/vocab': 'src/pages/vocab/vocab.tsx',
      'pages/player': 'src/pages/player/player.tsx',
    },
    format: 'iife',
  },
];

async function buildAll() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await copyStatic();
  await buildManifest();
  const ctxs = await Promise.all(
    builds.map((b) => esbuild.context({ ...common, ...b, outdir, absWorkingDir: root })),
  );
  await Promise.all(ctxs.map((c) => c.rebuild()));
  if (WATCH) {
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log(`watching… output in ${path.relative(root, outdir)}/`);
  } else {
    await Promise.all(ctxs.map((c) => c.dispose()));
    console.log(`built ${path.relative(root, outdir)}/ (v${pkg.version}${TEST ? ', test build' : ''})`);
  }
}

await buildAll();
