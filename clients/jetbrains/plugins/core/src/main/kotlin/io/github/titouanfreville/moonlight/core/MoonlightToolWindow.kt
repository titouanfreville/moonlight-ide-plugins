package io.github.titouanfreville.moonlight.core

import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionGroup
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.extensions.ExtensionPointName
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import com.intellij.openapi.util.Key
import com.intellij.util.ui.JBUI
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
import javax.swing.Icon
import javax.swing.JComponent

/**
 * A tab of the one MoonlightCode tool window.
 *
 * The feature plugins ship and install separately, but they are one product: sessions in one
 * window, the review in another, read as two tools. Core owns the window and each plugin adds
 * its tab through this extension point (`io.github.titouanfreville.moonlight.core.toolWindowTab`),
 * so whatever is installed lands in the same place — ordered by the extension's `order`.
 */
interface MoonlightToolWindowTab {
    /** The tab's title, and its key: [MoonlightToolWindow.select] finds a tab by it. */
    val title: String

    /** Shown on the tab — and alone, with the badge, when the window is too narrow for names. */
    val icon: Icon? get() = null

    /** Build the tab. Anything that must be released with it is registered on `parent`. */
    fun createComponent(project: Project, toolWindow: ToolWindow, parent: Disposable): JComponent

    companion object {
        val EP: ExtensionPointName<MoonlightToolWindowTab> =
            ExtensionPointName.create("io.github.titouanfreville.moonlight.core.toolWindowTab")
    }
}

class MoonlightToolWindowFactory : ToolWindowFactory, DumbAware {
    /** Core alone contributes nothing to show — the window appears with the first tab. */
    override suspend fun isApplicableAsync(project: Project): Boolean = MoonlightToolWindowTab.EP.extensionList.isNotEmpty()

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val factory = ContentFactory.getInstance()
        for (tab in MoonlightToolWindowTab.EP.extensionList) {
            val lifetime = Disposer.newDisposable("MoonlightCode tab ${tab.title}")
            val content = factory.createContent(tab.createComponent(project, toolWindow, lifetime), tab.title, false)
            content.isCloseable = false
            content.tabName = tab.title
            tab.icon?.let {
                content.icon = it
                content.putUserData(ToolWindow.SHOW_CONTENT_ICON, true)
            }
            content.putUserData(MoonlightToolWindow.LABEL, TabLabel(tab.title, null))
            Disposer.register(content, lifetime)
            toolWindow.contentManager.addContent(content)
        }
        // Names fit a wide window; a narrow one would push a tab out of sight, so the tabs
        // shrink to icon and badge instead.
        toolWindow.component.addComponentListener(object : ComponentAdapter() {
            override fun componentResized(e: ComponentEvent) = MoonlightToolWindow.relabel(toolWindow)
        })
    }
}

/**
 * What a tab says: its name, and a badge (a count) when there is something to count —
 * `badge` is what fits beside the icon, `longBadge` what reads in full ("2" / "2 waiting").
 */
data class TabLabel(val name: String, val badge: String?, val longBadge: String? = badge) {
    val full: String get() = if (longBadge == null) name else "$name ($longBadge)"

    /** Icon-only width: the badge alone, or nothing. */
    val compact: String get() = badge ?: ""
}

object MoonlightToolWindow {
    const val ID: String = "MoonlightCode"

    internal val LABEL: Key<TabLabel> = Key.create("moonlight.tabLabel")

    /**
     * Room the header keeps besides the tabs: the "MoonlightCode" title and the window's own
     * buttons (options, hide). Measured generously — a tab pushed into the overflow is lost.
     */
    private const val HEADER_RESERVE = 170

    /** A tab's own padding and icon, besides its text. */
    private const val TAB_CHROME = 44

    /**
     * Set the badge of the tab holding `component` — `null` for none. The tab shows
     * `name (badge)` when there is room and the badge alone beside its icon when there is
     * not; the full text stays in the tooltip either way. Call on the EDT.
     */
    fun setBadge(toolWindow: ToolWindow, component: JComponent, badge: String?, longBadge: String? = badge) {
        val content = toolWindow.contentManagerIfCreated?.contents?.firstOrNull { it.component === component } ?: return
        val label = content.getUserData(LABEL) ?: TabLabel(content.tabName, null)
        content.putUserData(LABEL, label.copy(badge = badge, longBadge = longBadge))
        relabel(toolWindow)
    }

    /**
     * Full names when every tab fits beside the header's title and buttons, icon and badge
     * otherwise — measured from the labels, not a fixed width, since a count can make a tab
     * twice as long.
     */
    internal fun relabel(toolWindow: ToolWindow) {
        val contents = toolWindow.contentManagerIfCreated?.contents.orEmpty()
        val component = toolWindow.component
        val width = component.width
        val metrics = component.getFontMetrics(JBUI.Fonts.label())
        val needed = JBUI.scale(HEADER_RESERVE) + contents.sumOf { c ->
            val label = c.getUserData(LABEL)?.full ?: c.displayName.orEmpty()
            metrics.stringWidth(label) + JBUI.scale(TAB_CHROME)
        }
        val compact = width > 0 && width < needed
        for (content in contents) {
            val label = content.getUserData(LABEL) ?: continue
            // Only a tab with an icon can drop its name and still be told apart.
            content.displayName = if (compact && content.icon != null) label.compact else label.full
            content.description = label.full
        }
    }

    /** The tabs other than the one showing — what [OtherTabsGroup] offers. */
    internal fun others(toolWindow: ToolWindow): List<com.intellij.ui.content.Content> {
        val manager = toolWindow.contentManagerIfCreated ?: return emptyList()
        return manager.contents.filter { it != manager.selectedContent }
    }

    /** Open the MoonlightCode window on the tab titled `title`. */
    fun select(project: Project, title: String) {
        val window = ToolWindowManager.getInstance(project).getToolWindow(ID) ?: return
        window.activate {
            val manager = window.contentManager
            manager.contents.firstOrNull { it.tabName == title }?.let(manager::setSelectedContent)
        }
    }
}

/**
 * A button in each tab's toolbar for every other MoonlightCode tab. The header's tabs can
 * still overflow in a window narrower than their icons; this way the other tab is always
 * one click away, whatever the header shows.
 */
class OtherTabsGroup : ActionGroup(), DumbAware {
    // On the EDT: it reads the window's tab list (ContentManager is Swing-owned state) and
    // caches one action per tab. Both are cheap; the per-tab actions update off it.
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun getChildren(e: AnActionEvent?): Array<AnAction> {
        val project = e?.project ?: return emptyArray()
        val window = ToolWindowManager.getInstance(project).getToolWindow(MoonlightToolWindow.ID) ?: return emptyArray()
        // One action per tab, kept on the tab: a toolbar must get the same instances on every
        // update, or it rebuilds its buttons each time (and the platform reports it).
        return MoonlightToolWindow.others(window).map { content ->
            content.getUserData(GO_TO) ?: GoToTab(content).also { content.putUserData(GO_TO, it) }
        }.toTypedArray()
    }

    private companion object {
        val GO_TO: Key<AnAction> = Key.create("moonlight.goToTab")
    }
}

/** Selects its tab; the label is read on each update, so a changing badge shows. */
private class GoToTab(private val content: Content) : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val name = content.getUserData(MoonlightToolWindow.LABEL)?.full ?: content.tabName
        e.presentation.text = "Go to $name"
        e.presentation.description = "Switch to the $name tab"
        e.presentation.icon = content.icon
    }

    override fun actionPerformed(e: AnActionEvent) {
        content.manager?.setSelectedContent(content, true)
    }
}
