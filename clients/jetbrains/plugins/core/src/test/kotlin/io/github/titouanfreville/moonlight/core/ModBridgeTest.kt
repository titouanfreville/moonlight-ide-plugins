package io.github.titouanfreville.moonlight.core

import io.github.titouanfreville.moonlight.client.Json
import io.github.titouanfreville.moonlight.client.Phase
import io.github.titouanfreville.moonlight.client.SessionStatus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.attribute.FileTime
import kotlin.concurrent.thread

/** Ported from `mod-bridge.test.ts`. */
class ModBridgeTest {
    private fun state(phase: String = "plan", pending: String = "null", plan: String = "null", id: String = "s1") =
        """{"v":1,"sessionId":"$id","root":"/work/app","phase":"$phase","pending":$pending,"plan":$plan,"updatedMs":0}"""

    @Test
    fun `phases map both ways`() {
        assertEquals(Phase.AutoImplement, ModBridge.daemonPhase("auto"))
        assertEquals("commit", ModBridge.modPhase(Phase.Commit))
    }

    @Test
    fun `parseState refuses another version or a torn write`() {
        assertEquals("s1", ModBridge.parseState(state())?.sessionId)
        assertNull(ModBridge.parseState(state().replace("\"v\":1", "\"v\":2")))
        assertNull(ModBridge.parseState(state().dropLast(3)))
    }

    @Test
    fun `a mod session reads as governed, waiting when it holds`() {
        val s = ModBridge.session(ModBridge.parseState(state(phase = "test"))!!)
        assertTrue(s.adopted)
        assertEquals(Phase.Test, s.phase)
        assertEquals(SessionStatus.Running, s.status)
        assertEquals("app (Claude Code plugin)", s.title)
        val waiting = ModBridge.parseState(state(pending = """{"to":"auto","reason":""}"""))!!
        assertEquals(SessionStatus.WaitingInput, ModBridge.session(waiting).status)
    }

    @Test
    fun `holds - an undecided plan first, then a phase request`() {
        val plan = """{"version":3,"title":"T","markdown":"# Plan"}"""
        val both = ModBridge.hold(ModBridge.parseState(state(plan = plan, pending = """{"to":"auto","reason":"go"}"""))!!, 5)!!
        assertEquals("approve plan", both.what)
        assertEquals("# Plan", both.plan)
        assertEquals(3, both.planVersion)
        val decided = plan.replace("}", ",\"decided\":\"refine\"}")
        val request = ModBridge.hold(ModBridge.parseState(state(plan = decided, pending = """{"to":"auto","reason":"go"}"""))!!, 5)!!
        assertEquals("phase change to AutoImplement: go", request.what)
        assertNull(request.plan)
        assertNull(ModBridge.hold(ModBridge.parseState(state())!!, 5))
    }

    @Test
    fun `entry names sort by time and stay one safe word`() {
        assertTrue(Regex("^[0-9]{15}-[A-Za-z0-9]+\\.json$").matches(ModBridge.entryName(5, "x/../y")))
        assertTrue(ModBridge.entryName(10, "a") > ModBridge.entryName(9, "z"))
    }

    @Test
    fun `readStates keeps live sessions only`() {
        val dir = Files.createTempDirectory("mod-bridge")
        for ((id, alive) in listOf("live" to true, "dead" to false)) {
            Files.createDirectories(dir.resolve(id))
            Files.writeString(dir.resolve(id).resolve("state.json"), state(id = id))
            val beat = Files.writeString(dir.resolve(id).resolve("heartbeat"), "1")
            if (!alive) Files.setLastModifiedTime(beat, FileTime.fromMillis(System.currentTimeMillis() - 60_000))
        }
        assertEquals(listOf("live"), ModBridge.readStates(dir, System.currentTimeMillis()).map { it.sessionId })
        assertEquals(emptyList<ModState>(), ModBridge.readStates(dir.resolve("missing"), System.currentTimeMillis()))
    }

    @Test
    fun `send writes the entry, waits for the answer, then cleans up`() {
        val dir = Files.createTempDirectory("mod-bridge")
        val inbox = dir.resolve("s1").resolve("inbox")
        // A stand-in for the mod's tick: answers whatever lands in the inbox.
        val mod = thread {
            repeat(200) {
                val names = runCatching { Files.list(inbox).use { s -> s.toList() } }.getOrDefault(emptyList())
                for (entry in names.filter { it.toString().endsWith(".json") }) {
                    val read = Json.parse(Files.readString(entry)) as Map<*, *>
                    val outbox = dir.resolve("s1").resolve("outbox")
                    Files.createDirectories(outbox)
                    Files.writeString(outbox.resolve(entry.fileName), """{"v":1,"ok":true,"message":"${read["kind"]}:${read["to"]}"}""")
                    return@thread
                }
                Thread.sleep(20)
            }
        }
        assertEquals(ModAnswer(true, "phase:auto"), ModBridge.send(dir, "s1", ModEntry.SetPhase(Phase.AutoImplement)))
        mod.join()
        assertEquals(0L, Files.list(inbox).use { it.count() })
    }

    @Test
    fun `send withdraws an entry nobody took`() {
        val dir = Files.createTempDirectory("mod-bridge")
        assertFalse(ModBridge.send(dir, "s1", ModEntry.Request(true), timeoutMs = 300).ok)
        assertEquals(0L, Files.list(dir.resolve("s1").resolve("inbox")).use { it.count() })
    }

    @Test
    fun `the review section is read, unknown entries skipped`() {
        val review = """{"scope":"session",""" +
            """"files":[{"path":"src/a.ts","absolute":"/p/src/a.ts","status":"M","added":1,"removed":1,"baseline":"/b/abc"},{"nope":1}],""" +
            """"comments":[{"id":"c1","path":"src/a.ts","side":"before","start":2,"end":3,"body":"why?"}],""" +
            """"findings":[{"id":"H1-1-0","key":"H1","severity":"high","route":"patch","file":"src/a.ts","line":4,"summary":"s","detail":"d","decision":"keep"}],""" +
            """"findingsStatus":"ok","run":{"skill":"code-review"},"skills":["code-review"]}"""
        val parsed = ModBridge.parseState(state().dropLast(1) + ",\"review\":" + review + "}")!!.review!!
        assertEquals(listOf("/p/src/a.ts"), parsed.files.map { it.absolute })
        assertEquals("/b/abc", parsed.files[0].baseline)
        assertEquals("before", parsed.comments[0].side)
        assertEquals("high", parsed.findings[0].severity)
        assertEquals("code-review", parsed.runningSkill)
        assertEquals(listOf("code-review"), parsed.skills)
    }

    @Test
    fun `review entries carry the mod field names`() {
        assertEquals(
            mapOf("kind" to "review-comment", "path" to "a", "side" to "after", "start" to 1, "end" to 2, "body" to "x"),
            ModEntry.ReviewComment("a", "after", 1, 2, "x").fields(),
        )
        assertEquals(mapOf("kind" to "finding", "id" to "H1", "decision" to "keep", "note" to "n"), ModEntry.Finding("H1", "keep", "n").fields())
    }
}
