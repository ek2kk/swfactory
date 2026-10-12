import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Problem } from './store.js';

const exec = promisify(execFile);
export const headlessArgs = [
  'computer_use', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
  'in_app_browser', 'apps', 'plugins', 'remote_plugin', 'hooks', 'skill_mcp_dependency_install',
].flatMap(feature => ['--disable', feature]);

export const headlessInstructions = `SW Factory execution policy: computer and browser control are disabled for this run.
Do not use or enable GUI tools, MCP servers, apps or plugins. Do not bypass this policy through shell, AppleScript/osascript, System Events, Playwright, Selenium, CDP, screenshots, or delegated agents.
You may inspect source, edit it when your role permits, and run non-GUI checks. Do not launch browser/desktop automation, including through project test commands.
If a required check needs a rendered interface or user interaction, return NEEDS_INPUT with concrete manual steps, expected results, and a required question asking the human to report observations. Do not attempt the check or return PASS/READY before receiving sufficient evidence.
Use the supplied human answers as human-provided evidence, explicitly attributed to the human and scoped to the reviewed code version; do not claim you performed the check. If evidence is incomplete, ask a follow-up. A code-only task does not need a GUI question.`;

export async function executionArgs(cwd: string, executable = 'codex') {
  try {
    const { stdout } = await exec(executable, ['mcp', 'list', '--json', ...headlessArgs], {
      cwd, timeout: 10_000, maxBuffer: 1024 * 1024,
    });
    const servers: unknown = JSON.parse(stdout);
    if (!Array.isArray(servers) || servers.some(server => !server || typeof server.name !== 'string' || !/^[\w-]+$/.test(server.name))) throw new Error();
    // Empty mcp_servers={} merges with inherited config; disable each effective server explicitly.
    return [...headlessArgs, ...servers.flatMap(server => ['-c', `mcp_servers.${server.name}.enabled=false`])];
  } catch {
    throw new Problem(422, 'Не удалось проверить и отключить MCP для запуска без computer use. Агент не запущен; проверьте Codex CLI и конфигурацию.');
  }
}
