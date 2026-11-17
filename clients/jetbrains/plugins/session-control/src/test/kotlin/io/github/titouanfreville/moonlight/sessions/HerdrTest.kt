package io.github.titouanfreville.moonlight.sessions

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** The herdr rules, in step with VS Code's `herdr.test.ts`. */
class HerdrTest {
    // Shaped like the herdr 0.9.5 responses this was written against.
    private val workspacesJson = """{"result":{"type":"workspace_list","workspaces":[
        {"workspace_id":"w9","label":"partoo","number":1,"focused":true},
        {"workspace_id":"wA","label":"ml-test","number":2,"focused":false},
        {"label":"no id"}]}}"""
    private val panesJson = """{"result":{"panes":[
        {"pane_id":"w9:p1","workspace_id":"w9","cwd":"/home/me/partoo","focused":true,"agent_session":{"value":"12b59906-a06f"}},
        {"pane_id":"wA:p1","workspace_id":"wA","cwd":"/home/me/ml","foreground_cwd":"/home/me/ml/crates"}]}}"""

    @Test
    fun `herdr JSON reads as workspaces and panes, entries without ids dropped`() {
        assertEquals(listOf("w9" to true, "wA" to false), parseWorkspaces(workspacesJson).map { it.id to it.focused })
        assertEquals(
            listOf(Triple("w9:p1", "/home/me/partoo", "12b59906-a06f"), Triple("wA:p1", "/home/me/ml/crates", null)),
            parsePanes(panesJson).map { Triple(it.paneId, it.cwd, it.sessionId) },
        )
        assertEquals(emptyList<HerdrPane>(), parsePanes("nonsense"))
    }

    @Test
    fun `a pane in a sibling folder sharing the prefix is not the repository's`() {
        val all = placements(listOf("/home/me/ml"), listOf(ws("w1", 1)), listOf(pane("w1:p1", "w1", "/home/me/ml-other")), null, "ml")
        assertEquals(Placement.NewWorkspace("ml"), all.first())
        val inside = placements(listOf("/home/me/ml"), listOf(ws("w1", 1)), listOf(pane("w1:p1", "w1", "/home/me/ml/crates/core")), null, "ml")
        assertTrue(inside.first() is Placement.Tab)
    }

    private fun ws(id: String, number: Int, focused: Boolean = false) = HerdrWorkspace(id, id, number, focused)
    private fun pane(id: String, workspace: String, cwd: String, focused: Boolean = false) = HerdrPane(id, workspace, cwd, null, focused)

    @Test
    fun `the repository's workspaces come first, the one last used here before the busiest`() {
        val workspaces = listOf(ws("w1", 1, true), ws("w2", 2), ws("w3", 3))
        val panes = listOf(pane("w1:p1", "w1", "/elsewhere", true), pane("w2:p1", "w2", "/repo"), pane("w3:p1", "w3", "/repo/a"), pane("w3:p2", "w3", "/repo/b"))
        fun order(last: String?) = placements(listOf("/repo"), workspaces, panes, last, "repo").filterIsInstance<Placement.Tab>().map { it.workspace.id }
        assertEquals(listOf("w3", "w2", "w1"), order(null))
        assertEquals(listOf("w2", "w3", "w1"), order("w2"))
        // A remembered workspace that no longer works here does not jump the queue.
        assertEquals(listOf("w3", "w2", "w1"), order("w1"))
        assertEquals(Placement.NewWorkspace("repo"), placements(listOf("/repo"), workspaces, panes, null, "repo").last())
    }

    @Test
    fun `with no workspace in the repository, a workspace of its own comes first`() {
        val all = placements(listOf("/repo"), listOf(ws("w1", 1, true)), listOf(pane("w1:p1", "w1", "/elsewhere", true)), null, "repo")
        assertEquals(Placement.NewWorkspace("repo"), all.first())
        assertEquals("New workspace \"repo\"", placementLabel(all.first()))
    }

    @Test
    fun `a split goes beside the focused pane, else one in the repository`() {
        val split = placements(listOf("/repo"), listOf(ws("w1", 1)), listOf(pane("w1:p1", "w1", "/elsewhere"), pane("w1:p2", "w1", "/repo")), null, "repo")
            .filterIsInstance<Placement.Split>().single()
        assertEquals("w1:p2", split.pane)
        val beside = placements(listOf("/repo"), listOf(ws("w1", 1)), listOf(pane("w1:p1", "w1", "/elsewhere", true), pane("w1:p2", "w1", "/repo")), null, "repo")
            .filterIsInstance<Placement.Split>().single()
        assertEquals("w1:p1", beside.pane)
    }

    @Test
    fun `creation commands never take focus and carry the launch variable`() {
        val env = mapOf("MOONLIGHT_LAUNCH_ID" to "abc")
        assertEquals(
            listOf("tab", "create", "--workspace", "w9", "--cwd", "/repo", "--env", "MOONLIGHT_LAUNCH_ID=abc", "--no-focus"),
            createArgs(Placement.Tab(ws("w9", 1), true), "/repo", env),
        )
        assertEquals(
            listOf("pane", "split", "w9:p1", "--direction", "right", "--cwd", "/repo", "--env", "MOONLIGHT_LAUNCH_ID=abc", "--no-focus"),
            createArgs(Placement.Split(ws("w9", 1), "w9:p1", true), "/repo", env),
        )
        assertEquals(
            listOf("workspace", "create", "--cwd", "/repo", "--label", "repo", "--env", "MOONLIGHT_LAUNCH_ID=abc", "--no-focus"),
            createArgs(Placement.NewWorkspace("repo"), "/repo", env),
        )
    }

    @Test
    fun `the new pane is read from either creation answer`() {
        assertEquals("wA:p1", createdPane("""{"result":{"workspace":{"workspace_id":"wA"},"root_pane":{"pane_id":"wA:p1"}}}"""))
        assertEquals("w9:p3", createdPane("""{"result":{"pane":{"pane_id":"w9:p3"}}}"""))
        assertNull(createdPane("""{"result":{}}"""))
    }

    @Test
    fun `agent start carries our session id, and the MCP config only when the daemon governs`() {
        val id = "72362684-0115-4749-a4ad-dcfbef32e279"
        assertEquals("ml-72362684", agentName(id))
        assertEquals(
            listOf("agent", "start", "ml-72362684", "--kind", "claude", "--pane", "wA:p1", "--timeout", "60000", "--", "--session-id", id),
            agentStartArgs(id, "wA:p1", null),
        )
        assertEquals(listOf("--mcp-config", "{}"), agentStartArgs(id, "wA:p1", "{}").takeLast(2))
    }

    @Test
    fun `the MCP config is plain JSON, and only for a loopback endpoint`() {
        assertEquals("""{"mcpServers":{"moonlight":{"type":"http","url":"http://127.0.0.1:5050/mcp"}}}""", mcpConfigJson("http://127.0.0.1:5050/mcp"))
        assertNull(mcpConfigJson("http://evil.example/mcp"))
    }

    @Test
    fun `herdr's error JSON reads as its message`() {
        assertEquals("no pane w9:p7", herdrError("""{"error":{"code":"pane_not_found","message":"no pane w9:p7"}}"""))
        assertEquals("plain failure", herdrError("plain failure\n"))
    }

    @Test
    fun `herdr is found on PATH, else where Homebrew and friends put it`() {
        fun at(vararg have: String): (String) -> Boolean = { it in have }
        assertEquals("/opt/homebrew/bin/herdr", findHerdr("", "/usr/bin:/bin", "/home/me", at("/opt/homebrew/bin/herdr")))
        assertEquals("/tools/herdr", findHerdr("", "/tools:/bin", "/home/me", at("/tools/herdr", "/opt/homebrew/bin/herdr")))
        assertEquals("/home/me/.local/bin/herdr", findHerdr("", "", "/home/me", at("/home/me/.local/bin/herdr")))
        // A configured path is the answer, or there is none: never silently another herdr.
        assertNull(findHerdr("/x/herdr", "", "/home/me", at("/opt/homebrew/bin/herdr")))
    }
}
