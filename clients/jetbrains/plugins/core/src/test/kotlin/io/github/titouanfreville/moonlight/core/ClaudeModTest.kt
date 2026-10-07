package io.github.titouanfreville.moonlight.core

import io.github.titouanfreville.moonlight.client.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Path

/** Ported from `claude-mod.test.ts`. */
class ClaudeModTest {
    private fun ok(stdout: String = "") = CliResult(0, stdout, "")
    private fun fail(stderr: String) = CliResult(1, "", stderr)

    private class Cli(val answer: (String) -> CliResult) {
        val calls = mutableListOf<String>()
        val run: RunClaude = { args -> args.joinToString(" ").also { calls += it }.let(answer) }
    }

    private class Memory(var text: String?) : SettingsFile {
        override fun read(): String? = text
        override fun write(text: String) {
            this.text = text
        }
    }

    @Test
    fun `modInList reads the plugin list`() {
        assertEquals(ClaudeMod.InList.Enabled, ClaudeMod.modInList("""[{"id":"moonlightcode@moonlight","enabled":true}]"""))
        assertEquals(ClaudeMod.InList.Disabled, ClaudeMod.modInList("""[{"id":"moonlightcode@moonlight","enabled":false}]"""))
        assertEquals(ClaudeMod.InList.Missing, ClaudeMod.modInList("""[{"id":"other@x","enabled":true}]"""))
        assertEquals(ClaudeMod.InList.Missing, ClaudeMod.modInList("nope"))
    }

    @Test
    fun `hasMarketplace finds a marketplace by name`() {
        assertTrue(ClaudeMod.hasMarketplace("""[{"name":"moonlight"}]""", "moonlight"))
        assertFalse(ClaudeMod.hasMarketplace("""[{"name":"bmad"}]""", "moonlight"))
        assertFalse(ClaudeMod.hasMarketplace("{", "moonlight"))
    }

    @Test
    fun `withFunctionHooks adds the switch and keeps the rest as written`() {
        val edit = ClaudeMod.withFunctionHooks("""{"model":"opus","cleanupPeriodDays":1700000000000,"env":{"FOO":"bar"}}""")
        val text = (edit as SettingsEdit.Write).text
        assertEquals(
            mapOf("model" to "opus", "cleanupPeriodDays" to 1700000000000L, "env" to mapOf("FOO" to "bar", "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS" to "1")),
            Json.parse(text),
        )
        assertTrue(text.contains("1700000000000"))
        assertTrue(ClaudeMod.functionHooksOn(text))
        assertEquals(SettingsEdit.Unchanged, ClaudeMod.withFunctionHooks(text))
        assertTrue(ClaudeMod.withFunctionHooks(null) is SettingsEdit.Write)
    }

    @Test
    fun `withFunctionHooks never replaces a file it cannot read`() {
        assertTrue(ClaudeMod.withFunctionHooks("""{ "model": """) is SettingsEdit.Refused)
        assertTrue(ClaudeMod.withFunctionHooks("[]") is SettingsEdit.Refused)
        assertTrue(ClaudeMod.withFunctionHooks("""{"env":"x"}""") is SettingsEdit.Refused)
    }

    @Test
    fun `readState is active only when enabled and function hooks are on`() {
        val enabled = Cli { ok("""[{"id":"moonlightcode@moonlight","enabled":true}]""") }
        assertEquals(ClaudeModState.Active, ClaudeMod.readState(enabled.run, Memory("""{"env":{"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS":"1"}}""")))
        assertEquals(ClaudeModState.Off, ClaudeMod.readState(enabled.run, Memory("{}")))
        assertEquals(ClaudeModState.Missing, ClaudeMod.readState(Cli { ok("[]") }.run, Memory("{}")))
        assertEquals(ClaudeModState.Unknown, ClaudeMod.readState(Cli { fail("no claude") }.run, Memory("{}")))
    }

    @Test
    fun `install adds the repository marketplace, installs, turns function hooks on`() {
        val cli = Cli { if (it.endsWith("--json")) ok("[]") else ok() }
        val settings = Memory("""{"model":"opus"}""")
        assertEquals(ModInstall.Installed(ModInstall.Source.Repository), ClaudeMod.install(cli.run, settings, Path.of("/b")))
        assertEquals(
            listOf(
                "plugin marketplace list --json",
                "plugin marketplace add titouanfreville/moonlight-ide-plugins --sparse .claude-plugin clients/claude-code",
                "plugin list --json",
                "plugin install moonlightcode@moonlight --scope user",
            ),
            cli.calls,
        )
        assertTrue(ClaudeMod.functionHooksOn(settings.text))
    }

    @Test
    fun `install falls back to the bundled marketplace`() {
        val cli = Cli {
            when {
                it.startsWith("plugin marketplace add titouanfreville") -> fail("network")
                it.endsWith("--json") -> ok("[]")
                else -> ok()
            }
        }
        assertEquals(ModInstall.Installed(ModInstall.Source.Bundled), ClaudeMod.install(cli.run, Memory(null), Path.of("/bundle")))
        assertTrue("plugin marketplace add /bundle" in cli.calls)
    }

    @Test
    fun `install reuses an existing marketplace and enables a disabled mod`() {
        val cli = Cli {
            when (it) {
                "plugin marketplace list --json" -> ok("""[{"name":"moonlight"}]""")
                "plugin list --json" -> ok("""[{"id":"moonlightcode@moonlight","enabled":false}]""")
                else -> ok()
            }
        }
        assertEquals(ModInstall.Installed(ModInstall.Source.Already), ClaudeMod.install(cli.run, Memory("{}"), null))
        assertEquals(listOf("plugin marketplace list --json", "plugin list --json", "plugin enable moonlightcode@moonlight"), cli.calls)
    }

    @Test
    fun `install stops at the first failure and keeps unreadable settings`() {
        val offline = Cli { if (it.endsWith("--json")) ok("[]") else fail("offline") }
        val failed = ClaudeMod.install(offline.run, Memory("{}"), null) as ModInstall.Failed
        assertEquals("Adding the moonlight marketplace failed (exit 1): offline", failed.error)

        val settings = Memory("{ broken")
        assertTrue(ClaudeMod.install(Cli { if (it.endsWith("--json")) ok("[]") else ok() }.run, settings, null) is ModInstall.Failed)
        assertEquals("{ broken", settings.text)
    }
}
