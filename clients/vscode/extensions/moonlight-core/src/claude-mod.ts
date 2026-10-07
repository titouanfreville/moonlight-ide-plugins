/**
 * The MoonlightCode mod for Claude Code, as the fallback backend.
 *
 * When no daemon can be started (a fresh install with no release to download, a
 * daemon that keeps crashing), sessions would otherwise run with nothing gating
 * them. The mod (`clients/claude-code/moonlight`) governs a session from inside
 * Claude Code instead, and stands by on its own whenever a daemon governs.
 *
 * It has to be *installed* into Claude Code, not passed at launch: the sessions
 * Anthropic's own Claude Code extensions start are launched by them, with flags
 * this window never sees. So the install is a user-scope plugin from the
 * `moonlight` marketplace (this repository, or the copy bundled in this
 * extension when GitHub is out of reach), plus the switch that turns function
 * hooks on, in the `env` block of Claude Code's user settings.
 *
 * Everything here that decides is pure; the side effects arrive as parameters.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** The marketplace and plugin names, as the repository's marketplace.json declares them. */
export const MARKETPLACE = 'moonlight';
export const PLUGIN_ID = `moonlightcode@${MARKETPLACE}`;
/** The repository's marketplace, checked out sparsely: its manifest and the mod. */
export const MARKETPLACE_REPO = 'titouanfreville/moonlight-ide-plugins';
export const MARKETPLACE_SPARSE = ['.claude-plugin', 'clients/claude-code'];
/** The environment switch function hooks need while they are early access. */
export const FUNCTION_HOOKS_VAR = 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS';

/**
 * - `active`   — installed, enabled, and function hooks are on: new sessions are governed.
 * - `off`      — installed but disabled, or function hooks are off: it will not load.
 * - `missing`  — not installed.
 * - `unknown`  — the `claude` CLI could not be asked.
 */
export type ClaudeModState = 'active' | 'off' | 'missing' | 'unknown';

/** What `claude plugin list --json` says of the mod. */
export function modInList(listJson: string): 'enabled' | 'disabled' | 'missing' {
  let entries: unknown;
  try {
    entries = JSON.parse(listJson);
  } catch {
    return 'missing';
  }
  if (!Array.isArray(entries)) {
    return 'missing';
  }
  const mine = entries.filter(
    (e): e is { id: string; enabled?: unknown } =>
      typeof e === 'object' && e !== null && typeof (e as { id?: unknown }).id === 'string' &&
      (e as { id: string }).id.startsWith('moonlightcode@')
  );
  if (mine.length === 0) {
    return 'missing';
  }
  return mine.some((e) => e.enabled === true) ? 'enabled' : 'disabled';
}

/** Whether `claude plugin marketplace list --json` names the marketplace. */
export function hasMarketplace(listJson: string, name: string): boolean {
  try {
    const entries = JSON.parse(listJson) as unknown;
    return Array.isArray(entries) && entries.some((e) => (e as { name?: unknown } | null)?.name === name);
  } catch {
    return false;
  }
}

/** Whether Claude Code's user settings turn function hooks on. */
export function functionHooksOn(settingsText: string | undefined): boolean {
  if (settingsText === undefined) {
    return false;
  }
  try {
    const env = (JSON.parse(settingsText) as { env?: Record<string, unknown> }).env;
    return env?.[FUNCTION_HOOKS_VAR] === '1' || env?.[FUNCTION_HOOKS_VAR] === 'true';
  } catch {
    return false;
  }
}

/**
 * The user settings with function hooks turned on, every other key kept.
 *
 * A file that does not parse is refused rather than replaced: it is the operator's,
 * and rewriting it from nothing would drop whatever they had in it.
 */
export function withFunctionHooks(
  settingsText: string | undefined
): { text: string } | { unchanged: true } | { error: string } {
  if (functionHooksOn(settingsText)) {
    return { unchanged: true };
  }
  let settings: Record<string, unknown> = {};
  if (settingsText !== undefined && settingsText.trim() !== '') {
    try {
      const parsed = JSON.parse(settingsText) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { error: 'Claude Code settings are not a JSON object' };
      }
      settings = parsed as Record<string, unknown>;
    } catch (err) {
      return { error: `Claude Code settings do not parse: ${String(err)}` };
    }
  }
  const env = settings.env;
  if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env))) {
    return { error: 'the "env" entry of Claude Code settings is not an object' };
  }
  settings.env = { ...(env as Record<string, unknown> | undefined), [FUNCTION_HOOKS_VAR]: '1' };
  return { text: `${JSON.stringify(settings, null, 2)}\n` };
}

/** The result of one `claude` CLI run. */
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the `claude` CLI with these arguments (never through a shell string). */
export type RunClaude = (args: readonly string[]) => Promise<CliResult>;

/** Claude Code's user settings, read and written whole. */
export interface SettingsFile {
  read(): string | undefined;
  write(text: string): void;
}

/** Where the mod stands, from the CLI and the settings. */
export async function readModState(run: RunClaude, settings: SettingsFile): Promise<ClaudeModState> {
  let listed: CliResult;
  try {
    listed = await run(['plugin', 'list', '--json']);
  } catch {
    return 'unknown';
  }
  if (listed.code !== 0) {
    return 'unknown';
  }
  const inList = modInList(listed.stdout);
  if (inList === 'missing') {
    return 'missing';
  }
  return inList === 'enabled' && functionHooksOn(settings.read()) ? 'active' : 'off';
}

export type InstallResult =
  | { ok: true; source: 'repository' | 'bundled' | 'already' }
  | { ok: false; error: string };

function failure(step: string, result: CliResult): string {
  const said = (result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ');
  return `${step} failed (exit ${result.code})${said ? `: ${said}` : ''}`;
}

/**
 * Installs and enables the mod for the user, then turns function hooks on.
 *
 * The repository's marketplace first, so the mod follows its releases; the copy
 * bundled with this extension when that cannot be reached (offline, GitHub down),
 * so a fresh install still ends governed. A `moonlight` marketplace already
 * configured is used as it is, whichever of the two it is.
 */
export async function installMod(
  run: RunClaude,
  settings: SettingsFile,
  bundledMarketplace: string | undefined
): Promise<InstallResult> {
  let source: 'repository' | 'bundled' | 'already' = 'already';
  const marketplaces = await run(['plugin', 'marketplace', 'list', '--json']);
  if (marketplaces.code !== 0) {
    return { ok: false, error: failure('Listing Claude Code marketplaces', marketplaces) };
  }
  if (!hasMarketplace(marketplaces.stdout, MARKETPLACE)) {
    const fromRepo = await run([
      'plugin', 'marketplace', 'add', MARKETPLACE_REPO, '--sparse', ...MARKETPLACE_SPARSE,
    ]);
    source = 'repository';
    if (fromRepo.code !== 0) {
      if (bundledMarketplace === undefined) {
        return { ok: false, error: failure('Adding the moonlight marketplace', fromRepo) };
      }
      const fromBundle = await run(['plugin', 'marketplace', 'add', bundledMarketplace]);
      if (fromBundle.code !== 0) {
        return { ok: false, error: failure('Adding the bundled moonlight marketplace', fromBundle) };
      }
      source = 'bundled';
    }
  }

  const listed = await run(['plugin', 'list', '--json']);
  const inList = listed.code === 0 ? modInList(listed.stdout) : 'missing';
  if (inList === 'missing') {
    const installed = await run(['plugin', 'install', PLUGIN_ID, '--scope', 'user']);
    if (installed.code !== 0) {
      return { ok: false, error: failure(`Installing ${PLUGIN_ID}`, installed) };
    }
  } else if (inList === 'disabled') {
    const enabled = await run(['plugin', 'enable', PLUGIN_ID]);
    if (enabled.code !== 0) {
      return { ok: false, error: failure(`Enabling ${PLUGIN_ID}`, enabled) };
    }
  }

  const next = withFunctionHooks(settings.read());
  if ('error' in next) {
    return { ok: false, error: next.error };
  }
  if ('text' in next) {
    settings.write(next.text);
  }
  return { ok: true, source };
}

/** Claude Code's user settings file: `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. */
export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR)
    ? env.CLAUDE_CONFIG_DIR
    : path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

/** The settings file on disk, written atomically so Claude Code never reads half of it. */
export function settingsFileAt(file: string): SettingsFile {
  return {
    read: () => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return undefined;
      }
    },
    write: (text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.moonlight-${process.pid}`;
      fs.writeFileSync(temp, text, 'utf8');
      fs.renameSync(temp, file);
    },
  };
}
