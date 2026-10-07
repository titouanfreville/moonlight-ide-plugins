import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.intellij.platform)
}

group = "io.github.titouanfreville.moonlight"
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
        // Runs on the IDE's bundled Kotlin stdlib — 2.2.20 in 2025.3, the oldest supported platform.
        apiVersion.set(KotlinVersion.KOTLIN_2_2)
        // Real interface default methods, no compatibility bridges: a bridge is an override of
        // every default method of every platform interface we implement, and the verifier
        // reports each one as a use of whatever the platform has since deprecated.
        freeCompilerArgs.add("-jvm-default=no-compatibility")
    }
}

dependencies {
    // Bundled into this plugin's lib/, and reached by every feature plugin through core's
    // classloader — one copy by construction, never one per plugin.
    implementation(project(":control-client"))
    intellijPlatform {
        intellijIdea(providers.gradleProperty("platformVersion"))
        // Owned terminals: the one place MoonlightCode can type into a session.
        bundledPlugin("org.jetbrains.plugins.terminal")
        // The terminal tab API (TerminalToolWindowTabsManager, TerminalView) lives in this
        // content module of the terminal plugin, not in its main jar.
        bundledModule("intellij.terminal.frontend")
    }
    testImplementation(libs.junit.jupiter)
    testRuntimeOnly(libs.junit.launcher)
    testRuntimeOnly(libs.junit4)
}

intellijPlatform {
    // Names the zip and the folder it unpacks to in the IDE's plugins directory.
    projectName = "moonlight-core"
    pluginVerification {
        ides {
            // `-PverifyIde=/Applications/PyCharm.app` checks against an installed IDE;
            // otherwise the IDEs JetBrains recommends for the sinceBuild range.
            val local = providers.gradleProperty("verifyIde").orNull
            if (local != null) local(file(local)) else recommended()
        }
    }
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("sinceBuild")
            untilBuild = provider { null }
        }
    }
    // Nothing here contributes searchable settings text worth indexing, and the task
    // boots a headless IDE — minutes per build for no benefit.
    buildSearchableOptions = false
}

tasks.test {
    useJUnitPlatform()
}

// The MoonlightCode mod for Claude Code, shipped as a local marketplace in this plugin's
// resources: on a fresh install with no daemon and no network to reach the repository's
// marketplace, this copy is what the IDE installs into Claude Code (see ClaudeMod.kt).
// `files.txt` lists the files, since a jar's resources cannot be listed as a folder.
val claudeModSource = rootProject.layout.projectDirectory.dir("../claude-code/moonlight")
val bundleClaudeMod by tasks.registering {
    val out = layout.buildDirectory.dir("generated/claude-mod")
    inputs.dir(claudeModSource)
    outputs.dir(out)
    doLast {
        val root = out.get().dir("moonlight/claude-mod").asFile
        root.deleteRecursively()
        val source = claudeModSource.asFile
        val shipped = listOf(".claude-plugin", "hooks", "types", "README.md")
        val leftBehind = { f: File ->
            f.name.endsWith(".test.ts") || f.name.endsWith(".test.tsx") || f.name == "gate-kit.ts" ||
                f.relativeTo(source).invariantSeparatorsPath.startsWith(".claude-plugin/types")
        }
        val files = shipped.map { source.resolve(it) }
            .flatMap { if (it.isDirectory) it.walkTopDown().filter(File::isFile).toList() else listOf(it) }
            .filterNot(leftBehind)
        for (file in files) file.copyTo(root.resolve("moonlightcode/${file.relativeTo(source).invariantSeparatorsPath}"), overwrite = true)
        val manifest = groovy.json.JsonSlurper().parse(source.resolve(".claude-plugin/plugin.json")) as Map<*, *>
        val marketplace = mapOf(
            // The repository's marketplace name: either copy installs `moonlightcode@moonlight`.
            "name" to "moonlight",
            "owner" to mapOf("name" to "Titouan Freville"),
            "plugins" to listOf(
                mapOf(
                    "name" to "moonlightcode",
                    "source" to "./moonlightcode",
                    "version" to manifest["version"],
                    "description" to manifest["description"],
                ),
            ),
        )
        root.resolve(".claude-plugin").mkdirs()
        root.resolve(".claude-plugin/marketplace.json").writeText(groovy.json.JsonOutput.prettyPrint(groovy.json.JsonOutput.toJson(marketplace)) + "\n")
        val listed = root.walkTopDown().filter(File::isFile).map { it.relativeTo(root).invariantSeparatorsPath }.sorted()
        root.resolve("files.txt").writeText(listed.joinToString("\n") + "\n")
    }
}

sourceSets.main {
    resources.srcDir(bundleClaudeMod)
}
