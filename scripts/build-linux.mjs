// Builds release/playprobe-linux.tar.gz for an Ubuntu / Debian server: the bundled server (server.cjs), the web app,
// helper scripts and instructions. Node, ffmpeg and srt-tools are installed on the server by setup-ubuntu.sh.
// Usage: npm run build:linux
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, 'release', 'playprobe-linux');
const win = process.platform === 'win32';

console.log('1/3 building the web app');
execSync('npm run build', { cwd: root, stdio: 'inherit' });

console.log('2/3 bundling the server');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, 'server', 'standalone.ts')],
  outfile: join(out, 'server.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // import.meta.url is not used on the server: PLAYPROBE_HOME (set by start.sh) names the folder.
  define: { 'import.meta.url': '"file:///playprobe/server/standalone.ts"' },
  logLevel: 'warning',
});
cpSync(join(root, 'dist'), join(out, 'dist'), { recursive: true });
// Shell scripts must use LF line endings.
for (const f of readdirSync(join(root, 'deploy', 'linux'))) {
  writeFileSync(join(out, f), readFileSync(join(root, 'deploy', 'linux', f), 'utf8').replace(/\r\n/g, '\n'));
}

console.log('3/3 packing');
const tar = win ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';
const file = join(root, 'release', 'playprobe-linux.tar.gz');
rmSync(file, { force: true });
execSync(`"${tar}" -c -z -f "${file}" -C "${join(root, 'release')}" playprobe-linux`, { stdio: 'inherit' });
if (!existsSync(file)) throw new Error('packing failed');
console.log(`\nDone: ${file}`);
