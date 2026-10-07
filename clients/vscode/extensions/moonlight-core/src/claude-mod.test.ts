import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type CliResult,
  functionHooksOn,
  hasMarketplace,
  installMod,
  modInList,
  readModState,
  type SettingsFile,
  withFunctionHooks,
} from './claude-mod';

const ok = (stdout = ''): CliResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): CliResult => ({ code: 1, stdout: '', stderr });

/** A scripted CLI: answers in order of the commands it recognises, and records every call. */
function cli(answer: (args: string) => CliResult) {
  const calls: string[] = [];
  return {
    calls,
    run: async (args: readonly string[]) => {
      calls.push(args.join(' '));
      return answer(args.join(' '));
    },
  };
}

function memorySettings(text: string | undefined): SettingsFile & { text: string | undefined } {
  const file = {
    text,
    read: () => file.text,
    write: (next: string) => {
      file.text = next;
    },
  };
  return file;
}

test('modInList reads the plugin list', () => {
  assert.equal(modInList('[{"id":"moonlightcode@moonlight","enabled":true}]'), 'enabled');
  assert.equal(modInList('[{"id":"moonlightcode@moonlight","enabled":false}]'), 'disabled');
  assert.equal(modInList('[{"id":"other@x","enabled":true}]'), 'missing');
  assert.equal(modInList('nope'), 'missing');
});

test('hasMarketplace finds a marketplace by name', () => {
  assert.equal(hasMarketplace('[{"name":"moonlight"}]', 'moonlight'), true);
  assert.equal(hasMarketplace('[{"name":"bmad"}]', 'moonlight'), false);
  assert.equal(hasMarketplace('{', 'moonlight'), false);
});

test('withFunctionHooks adds the switch and keeps the rest', () => {
  const next = withFunctionHooks('{"model":"opus","env":{"FOO":"bar"}}');
  assert.ok('text' in next);
  const parsed = JSON.parse(next.text);
  assert.deepEqual(parsed, { model: 'opus', env: { FOO: 'bar', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } });
  assert.equal(functionHooksOn(next.text), true);
  assert.deepEqual(withFunctionHooks(next.text), { unchanged: true });
  assert.ok('text' in withFunctionHooks(undefined));
});

test('withFunctionHooks never replaces a file it cannot read', () => {
  assert.ok('error' in withFunctionHooks('{ "model": '));
  assert.ok('error' in withFunctionHooks('[]'));
  assert.ok('error' in withFunctionHooks('{"env":"x"}'));
});

test('readModState: active only when enabled and function hooks are on', async () => {
  const enabled = cli(() => ok('[{"id":"moonlightcode@moonlight","enabled":true}]'));
  assert.equal(await readModState(enabled.run, memorySettings('{"env":{"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS":"1"}}')), 'active');
  assert.equal(await readModState(enabled.run, memorySettings('{}')), 'off');
  assert.equal(await readModState(cli(() => ok('[]')).run, memorySettings('{}')), 'missing');
  assert.equal(await readModState(cli(() => fail('no claude')).run, memorySettings('{}')), 'unknown');
});

test('installMod: repository marketplace, install, function hooks', async () => {
  const c = cli((args) => (args.includes('list --json') && args.startsWith('plugin marketplace') ? ok('[]') : args === 'plugin list --json' ? ok('[]') : ok()));
  const settings = memorySettings('{"model":"opus"}');
  assert.deepEqual(await installMod(c.run, settings, '/b'), { ok: true, source: 'repository' });
  assert.deepEqual(c.calls, [
    'plugin marketplace list --json',
    'plugin marketplace add titouanfreville/moonlight-ide-plugins --sparse .claude-plugin clients/claude-code',
    'plugin list --json',
    'plugin install moonlightcode@moonlight --scope user',
  ]);
  assert.equal(functionHooksOn(settings.text), true);
  assert.equal(JSON.parse(settings.text!).model, 'opus');
});

test('installMod: the bundled marketplace when the repository cannot be reached', async () => {
  const c = cli((args) =>
    args.startsWith('plugin marketplace add titouanfreville') ? fail('network') :
    args.endsWith('--json') ? ok('[]') : ok()
  );
  assert.deepEqual(await installMod(c.run, memorySettings(undefined), '/bundle'), { ok: true, source: 'bundled' });
  assert.ok(c.calls.includes('plugin marketplace add /bundle'));
});

test('installMod: an existing marketplace and a disabled mod are reused', async () => {
  const c = cli((args) =>
    args === 'plugin marketplace list --json' ? ok('[{"name":"moonlight"}]') :
    args === 'plugin list --json' ? ok('[{"id":"moonlightcode@moonlight","enabled":false}]') : ok()
  );
  assert.deepEqual(await installMod(c.run, memorySettings('{}'), undefined), { ok: true, source: 'already' });
  assert.deepEqual(c.calls, ['plugin marketplace list --json', 'plugin list --json', 'plugin enable moonlightcode@moonlight']);
});

test('installMod: stops at the first failure and says where', async () => {
  const noBundle = cli((args) => (args.endsWith('--json') ? ok('[]') : fail('offline')));
  const result = await installMod(noBundle.run, memorySettings('{}'), undefined);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /Adding the moonlight marketplace failed \(exit 1\): offline/);

  const badSettings = cli((args) => (args.endsWith('--json') ? ok('[]') : ok()));
  const settings = memorySettings('{ broken');
  assert.equal((await installMod(badSettings.run, settings, undefined)).ok, false);
  assert.equal(settings.text, '{ broken');
});
