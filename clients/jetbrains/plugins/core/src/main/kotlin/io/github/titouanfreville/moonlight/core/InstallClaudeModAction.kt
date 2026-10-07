package io.github.titouanfreville.moonlight.core

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/** Installs the MoonlightCode plugin for Claude Code, the fallback when no daemon runs (see [ClaudeMod]). */
class InstallClaudeModAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) = MoonlightApi.getInstance().installClaudeMod(e.project)
}
