import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const script = `
tell application "Finder"
try
  activate
  return POSIX path of (choose folder with prompt "Выберите папку проекта")
on error errorMessage number errorNumber
  if errorNumber is -128 then return ""
  error errorMessage number errorNumber
end try
end tell`;

export async function chooseProjectFolder(
  execute: (script: string) => Promise<string> = async script => {
    const { stdout } = await exec('/usr/bin/osascript', ['-e', script], { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 });
    return stdout;
  },
): Promise<string | null> {
  if (process.platform !== 'darwin') throw new Error('Folder selection requires macOS.');
  // Remove only osascript's final newline; whitespace can belong to the path.
  const path = (await execute(script)).replace(/\n$/, '');
  if (!path) return null;
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Invalid folder dialog result.');
  return path;
}
