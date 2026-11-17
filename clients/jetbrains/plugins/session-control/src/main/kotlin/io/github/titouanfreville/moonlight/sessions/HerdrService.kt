package io.github.titouanfreville.moonlight.sessions

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project

/** The project's herdr runner, kept so its few-second pane cache serves the toolbar and the menus. */
@Service(Service.Level.PROJECT)
class HerdrService(private val project: Project) {
    val cli = HerdrCli { SessionControlSettings.of(project).state.herdrPath ?: "" }

    companion object {
        fun of(project: Project): HerdrService = project.service()
    }
}
