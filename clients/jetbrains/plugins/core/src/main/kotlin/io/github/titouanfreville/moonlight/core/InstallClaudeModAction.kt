package io.github.titouanfreville.moonlight.core

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAwareAction

/** Installs the MoonlightCode plugin for Claude Code, the fallback when no daemon runs (see [ClaudeMod]). */
class InstallClaudeModAction : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) = MoonlightApi.getInstance().installClaudeMod(e.project)
}
