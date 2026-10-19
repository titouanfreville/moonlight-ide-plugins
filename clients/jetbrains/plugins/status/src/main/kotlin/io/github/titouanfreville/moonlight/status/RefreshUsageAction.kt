package io.github.titouanfreville.moonlight.status

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAwareAction
import io.github.titouanfreville.moonlight.core.MoonlightApi

/** Force a read instead of waiting out the poll interval. */
class RefreshUsageAction : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        MoonlightApi.getInstance().refresh()
    }
}
