package io.github.titouanfreville.moonlight.core

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import io.github.titouanfreville.moonlight.client.Json
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption

/**
 * The MoonlightCode mod for Claude Code, as the fallback backend. Ported from VS Code's
 * `moonlight-core/src/claude-mod.ts`, step for step.
 *
 * When no daemon can be started (a fresh install with no release to download, a daemon
 * that keeps crashing), sessions would otherwise run with nothing gating them. The mod
 * (`clients/claude-code/moonlight`) governs a session from inside Claude Code instead,
 * and stands by on its own whenever a daemon governs.
 *
 * It has to be *installed* into Claude Code, not passed at launch: the sessions
 * Anthropic's own Claude Code plugin starts are launched by it, with flags this IDE never
 * sees. So the install is a user-scope plugin from the `moonlight` marketplace (the
 * repository, or the copy bundled in this plugin when GitHub is out of reach), plus the
 * switch that turns function hooks on, in the `env` block of Claude Code's user settings.
 */
object ClaudeMod {
    const val MARKETPLACE = "moonlight"
    const val PLUGIN_ID = "moonlightcode@$MARKETPLACE"
    const val MARKETPLACE_REPO = "titouanfreville/moonlight-ide-plugins"
    val MARKETPLACE_SPARSE = listOf(".claude-plugin", "clients/claude-code")
    const val FUNCTION_HOOKS_VAR = "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"

    /** What `claude plugin list --json` says of the mod. */
    fun modInList(listJson: String): InList {
        val entries = runCatching { Json.parse(listJson) }.getOrNull() as? List<*> ?: return InList.Missing
        val mine = entries.mapNotNull { it as? Map<*, *> }.filter { (it["id"] as? String)?.startsWith("moonlightcode@") == true }
        return when {
            mine.isEmpty() -> InList.Missing
            mine.any { it["enabled"] == true } -> InList.Enabled
            else -> InList.Disabled
        }
    }

    /** Whether `claude plugin marketplace list --json` names the marketplace. */
    fun hasMarketplace(listJson: String, name: String): Boolean =
        (runCatching { Json.parse(listJson) }.getOrNull() as? List<*>)?.any { (it as? Map<*, *>)?.get("name") == name } == true

    /** Whether Claude Code's user settings turn function hooks on. */
    fun functionHooksOn(settingsText: String?): Boolean {
        if (settingsText == null) return false
        val env = (runCatching { Json.parse(settingsText) }.getOrNull() as? Map<*, *>)?.get("env") as? Map<*, *>
        val value = env?.get(FUNCTION_HOOKS_VAR)
        return value == "1" || value == "true"
    }

    /**
     * The user settings with function hooks turned on, every other key kept as written
     * (Gson's tree keeps numbers as their text). A file that does not parse is refused
     * rather than replaced: it is the operator's.
     */
    fun withFunctionHooks(settingsText: String?): SettingsEdit {
        if (functionHooksOn(settingsText)) return SettingsEdit.Unchanged
        val settings = if (settingsText.isNullOrBlank()) {
            JsonObject()
        } else {
            val parsed = try {
                JsonParser.parseString(settingsText)
            } catch (e: Exception) {
                return SettingsEdit.Refused("Claude Code settings do not parse: ${e.message}")
            }
            if (!parsed.isJsonObject) return SettingsEdit.Refused("Claude Code settings are not a JSON object")
            parsed.asJsonObject
        }
        val env = settings.get("env")
        if (env != null && !env.isJsonObject) return SettingsEdit.Refused("the \"env\" entry of Claude Code settings is not an object")
        val nextEnv = env?.asJsonObject ?: JsonObject().also { settings.add("env", it) }
        nextEnv.addProperty(FUNCTION_HOOKS_VAR, "1")
        return SettingsEdit.Write(GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create().toJson(settings) + "\n")
    }

    /** Where the mod stands, from the CLI and the settings. */
    fun readState(run: RunClaude, settings: SettingsFile): ClaudeModState {
        val listed = runCatching { run(listOf("plugin", "list", "--json")) }.getOrNull() ?: return ClaudeModState.Unknown
        if (listed.code != 0) return ClaudeModState.Unknown
        return when (modInList(listed.stdout)) {
            InList.Missing -> ClaudeModState.Missing
            InList.Enabled -> if (functionHooksOn(settings.read())) ClaudeModState.Active else ClaudeModState.Off
            InList.Disabled -> ClaudeModState.Off
        }
    }

    /**
     * Installs and enables the mod for the user, then turns function hooks on: the
     * repository's marketplace first, the bundled copy when that cannot be reached. A
     * `moonlight` marketplace already configured is used as it is.
     */
    fun install(run: RunClaude, settings: SettingsFile, bundledMarketplace: Path?): ModInstall {
        var source = ModInstall.Source.Already
        val marketplaces = run(listOf("plugin", "marketplace", "list", "--json"))
        if (marketplaces.code != 0) return ModInstall.Failed(failure("Listing Claude Code marketplaces", marketplaces))
        if (!hasMarketplace(marketplaces.stdout, MARKETPLACE)) {
            val fromRepo = run(listOf("plugin", "marketplace", "add", MARKETPLACE_REPO, "--sparse") + MARKETPLACE_SPARSE)
            source = ModInstall.Source.Repository
            if (fromRepo.code != 0) {
                if (bundledMarketplace == null) return ModInstall.Failed(failure("Adding the moonlight marketplace", fromRepo))
                val fromBundle = run(listOf("plugin", "marketplace", "add", bundledMarketplace.toString()))
                if (fromBundle.code != 0) return ModInstall.Failed(failure("Adding the bundled moonlight marketplace", fromBundle))
                source = ModInstall.Source.Bundled
            }
        }

        val listed = run(listOf("plugin", "list", "--json"))
        when (if (listed.code == 0) modInList(listed.stdout) else InList.Missing) {
            InList.Missing -> {
                val installed = run(listOf("plugin", "install", PLUGIN_ID, "--scope", "user"))
                if (installed.code != 0) return ModInstall.Failed(failure("Installing $PLUGIN_ID", installed))
            }
            InList.Disabled -> {
                val enabled = run(listOf("plugin", "enable", PLUGIN_ID))
                if (enabled.code != 0) return ModInstall.Failed(failure("Enabling $PLUGIN_ID", enabled))
            }
            InList.Enabled -> Unit
        }

        when (val edit = withFunctionHooks(settings.read())) {
            is SettingsEdit.Refused -> return ModInstall.Failed(edit.reason)
            is SettingsEdit.Write -> settings.write(edit.text)
            SettingsEdit.Unchanged -> Unit
        }
        return ModInstall.Installed(source)
    }

    private fun failure(step: String, result: CliResult): String {
        val said = result.stderr.ifBlank { result.stdout }.trim().lines().takeLast(3).joinToString(" ")
        return "$step failed (exit ${result.code})" + if (said.isNotEmpty()) ": $said" else ""
    }

    /** Claude Code's user settings: `$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. */
    fun settingsPath(env: Map<String, String> = System.getenv()): Path {
        val dir = env["CLAUDE_CONFIG_DIR"]?.let(Path::of)?.takeIf { it.isAbsolute }
            ?: Path.of(System.getProperty("user.home"), ".claude")
        return dir.resolve("settings.json")
    }

    /** The settings file on disk, replaced atomically so Claude Code never reads half of it. */
    fun settingsFileAt(file: Path): SettingsFile = object : SettingsFile {
        override fun read(): String? = runCatching { Files.readString(file) }.getOrNull()

        override fun write(text: String) {
            Files.createDirectories(file.parent)
            val temp = file.resolveSibling("${file.fileName}.moonlight-${ProcessHandle.current().pid()}")
            Files.writeString(temp, text)
            Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
        }
    }

    enum class InList { Enabled, Disabled, Missing }
}

/**
 * - `Active`  — installed, enabled, and function hooks are on: new sessions are governed.
 * - `Off`     — installed but disabled, or function hooks are off: it will not load.
 * - `Missing` — not installed.
 * - `Unknown` — the `claude` CLI could not be asked (or the daemon is up, so it was not).
 */
enum class ClaudeModState { Active, Off, Missing, Unknown }

data class CliResult(val code: Int, val stdout: String, val stderr: String)

/** Runs the `claude` CLI with these arguments (never through a shell string). */
typealias RunClaude = (List<String>) -> CliResult

/** Claude Code's user settings, read and written whole. */
interface SettingsFile {
    fun read(): String?
    fun write(text: String)
}

sealed interface SettingsEdit {
    data class Write(val text: String) : SettingsEdit
    data object Unchanged : SettingsEdit
    data class Refused(val reason: String) : SettingsEdit
}

sealed interface ModInstall {
    enum class Source { Repository, Bundled, Already }
    data class Installed(val source: Source) : ModInstall
    data class Failed(val error: String) : ModInstall
}
