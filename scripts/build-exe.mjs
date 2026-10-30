// Builds release/PlayProbe/PlayProbe.exe: a single executable with the app embedded, plus tools/
// (ffmpeg and the SRT tools) next to it. Usage: npm run build:exe
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { inject } from 'postject';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, 'release', 'PlayProbe');
const work = join(root, 'build');
const win = process.platform === 'win32';
const exe = win ? '.exe' : '';
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });
const which = (name) => {
  try {
    return execSync(win ? `where ${name}` : `command -v ${name}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
};

console.log('1/5 building the web app');
run('npm run build');

console.log('2/5 bundling the server');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
await build({
  entryPoints: [join(root, 'server.js')],
  outfile: join(work, 'app.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // import.meta.url is only read when not running as the executable.
  define: { 'import.meta.url': '"file:///playprobe-embedded/server.js"' },
  logLevel: 'warning',
});

console.log('3/5 embedding dist/ into the executable');
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(join(root, 'frontend', 'dist'), p).replace(/\\/g, '/'));
  }
})(join(root, 'frontend', 'dist'));
writeFileSync(join(work, 'manifest.json'), JSON.stringify(files));
const assets = { 'manifest.json': join(work, 'manifest.json') };
for (const f of files) assets[f] = join(root, 'frontend', 'dist', f);
writeFileSync(
  join(work, 'sea-config.json'),
  JSON.stringify({ main: join(work, 'app.cjs'), output: join(work, 'sea.blob'), disableExperimentalSEAWarning: true, useCodeCache: false, assets }),
);
run(`node --experimental-sea-config "${join(work, 'sea-config.json')}"`);

console.log(`4/5 writing PlayProbe${exe}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const target = join(out, `PlayProbe${exe}`);
copyFileSync(process.execPath, target);
await inject(target, 'NODE_SEA_BLOB', readFileSync(join(work, 'sea.blob')), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
});

// A console-less program: the installed app has no black window. (Windows only; it is a flag in the PE header.)
if (win) {
  const exeBytes = readFileSync(target);
  const peOffset = exeBytes.readUInt32LE(0x3c);
  exeBytes.writeUInt16LE(2, peOffset + 4 + 20 + 68); // Subsystem = IMAGE_SUBSYSTEM_WINDOWS_GUI
  writeFileSync(target, exeBytes);
}

console.log('5/5 copying ffmpeg and the SRT tools into tools/');
const tools = join(out, 'tools');
mkdirSync(tools, { recursive: true });
const ffmpeg = process.env.FFMPEG_PATH || which('ffmpeg');
if (ffmpeg && existsSync(ffmpeg)) copyFileSync(ffmpeg, join(tools, `ffmpeg${exe}`));
else console.warn(`  ffmpeg not found: copy ffmpeg${exe} into tools/ yourself`);
const candidates = [
  process.env.SRT_LIVE_TRANSMIT_PATH,
  which('srt-live-transmit'),
  'C:/msys64/mingw64/bin/srt-live-transmit.exe',
  'C:/msys64/ucrt64/bin/srt-live-transmit.exe',
];
const srtTool = candidates.find((c) => c && existsSync(c));
if (srtTool) {
  copyFileSync(srtTool, join(tools, `srt-live-transmit${exe}`));
  // Windows (MSYS2) builds need their DLLs beside the program.
  if (win) {
    const dlls = readdirSync(dirname(srtTool)).filter((f) => /^(libsrt|libssl|libcrypto|libgcc_s|libstdc\+\+|libwinpthread|zlib1|libz)[\w.+-]*\.dll$/i.test(f));
    for (const dll of dlls) copyFileSync(join(dirname(srtTool), dll), join(tools, dll));
  }
} else {
  console.warn('  srt-live-transmit not found: SRT link statistics will be unavailable');
}

writeFileSync(
  join(out, 'README.txt'),
  [
    'PlayProbe',
    '',
    `Double-click PlayProbe${exe}. A window opens (keep it open) and your browser opens http://localhost:4173/.`,
    'Close the window to stop PlayProbe and every SRT / UDP channel.',
    '',
    'Files created next to the program:',
    '  logs/<date>/   daily logs',
    '  .playprobe/    your channel names, rules and Slack / email settings (contains secrets)',
    '',
    'Options (environment variables): PORT, HOST, SRT_WEBHOOK_URL, SRT_WEBHOOK_KIND, FFMPEG_PATH.',
    '',
  ].join('\r\n'),
);
rmSync(work, { recursive: true, force: true });

// Zip it for sending to another computer. The plain zip stores nothing; the "private" one also carries this
// computer's channel names, rules and Slack / email settings (secrets), so share that one with care.
console.log('zipping');
const release = join(root, 'release');
// Windows' own bsdtar writes .zip; a GNU tar earlier on PATH (Git Bash) would not.
const tar = win ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';
const zip = (name) => {
  rmSync(join(release, name), { force: true });
  execSync(`"${tar}" -a -c -f "${join(release, name)}" -C "${release}" PlayProbe`, { stdio: 'inherit' });
};
zip('PlayProbe-portable.zip');
const settings = join(root, '.playprobe', 'srt-settings.json');
if (existsSync(settings)) {
  mkdirSync(join(out, '.playprobe'), { recursive: true });
  copyFileSync(settings, join(out, '.playprobe', 'srt-settings.json'));
  zip('PlayProbe-portable-PRIVATE-with-settings.zip');
  rmSync(join(out, '.playprobe'), { recursive: true, force: true });
}
// Windows installer (needs Inno Setup 6: winget install JRSoftware.InnoSetup).
const iscc = [
  process.env.ISCC_PATH,
  join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  join(process.env['ProgramFiles(x86)'] ?? '', 'Inno Setup 6', 'ISCC.exe'),
  join(process.env.ProgramFiles ?? '', 'Inno Setup 6', 'ISCC.exe'),
].find((p) => p && existsSync(p));
let setup = null;
if (win && iscc) {
  console.log('building the installer');
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  execSync(`"${iscc}" /Qp "/DSrc=${out}" "/DVersion=${version}" "/O${release}" "${join(root, 'installer', 'playprobe.iss')}"`, { stdio: 'inherit' });
  setup = join(release, `PlayProbe-Setup-${version}.exe`);
} else if (win) {
  console.warn('Inno Setup not found: skipping the installer (winget install JRSoftware.InnoSetup)');
}
console.log(`\nDone: ${target}\n      ${join(release, 'PlayProbe-portable.zip')}${setup ? `\n      ${setup}` : ''}`);
