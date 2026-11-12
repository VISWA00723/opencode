import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { $ } from "bun"
import path from "path"
import { Session } from "../../src/session"
import { SessionRevert } from "../../src/session/revert"
import { SessionCompaction } from "../../src/session/compaction"
import { MessageV2 } from "../../src/session/message-v2"
import { Snapshot } from "../../src/snapshot"
import { Server } from "../../src/server/server"
import { Bus } from "../../src/bus"
import { Global } from "../../src/global"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("revert + compact workflow", () => {
  test("should properly handle compact command after revert", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Create a session
        const session = await Session.create({})
        const sessionID = session.id

        // Create a user message
        const userMsg1 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "default",
          model: {
            providerID: "openai",
            modelID: "gpt-4",
          },
          time: {
            created: Date.now(),
          },
        })

        // Add a text part to the user message
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMsg1.id,
          sessionID,
          type: "text",
          text: "Hello, please help me",
        })

        // Create an assistant response message
        const assistantMsg1: MessageV2.Assistant = {
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID,
          mode: "default",
          agent: "default",
          path: {
            cwd: tmp.path,
            root: tmp.path,
          },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: "gpt-4",
          providerID: "openai",
          parentID: userMsg1.id,
          time: {
            created: Date.now(),
          },
          finish: "end_turn",
        }
        await Session.updateMessage(assistantMsg1)

        // Add a text part to the assistant message
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMsg1.id,
          sessionID,
          type: "text",
          text: "Sure, I'll help you!",
        })

        // Create another user message
        const userMsg2 = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "default",
          model: {
            providerID: "openai",
            modelID: "gpt-4",
          },
          time: {
            created: Date.now(),
          },
        })

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMsg2.id,
          sessionID,
          type: "text",
          text: "What's the capital of France?",
        })

        // Create another assistant response
        const assistantMsg2: MessageV2.Assistant = {
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID,
          mode: "default",
          agent: "default",
          path: {
            cwd: tmp.path,
            root: tmp.path,
          },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: "gpt-4",
          providerID: "openai",
          parentID: userMsg2.id,
          time: {
            created: Date.now(),
          },
          finish: "end_turn",
        }
        await Session.updateMessage(assistantMsg2)

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMsg2.id,
          sessionID,
          type: "text",
          text: "The capital of France is Paris.",
        })

        // Verify messages before revert
        let messages = await Session.messages({ sessionID })
        expect(messages.length).toBe(4) // 2 user + 2 assistant messages
        const messageIds = messages.map((m) => m.info.id)
        expect(messageIds).toContain(userMsg1.id)
        expect(messageIds).toContain(userMsg2.id)
        expect(messageIds).toContain(assistantMsg1.id)
        expect(messageIds).toContain(assistantMsg2.id)

        // Revert the last user message (userMsg2)
        await SessionRevert.revert({
          sessionID,
          messageID: userMsg2.id,
        })

        // Check that revert state is set
        let sessionInfo = await Session.get(sessionID)
        expect(sessionInfo.revert).toBeDefined()
        const revertMessageID = sessionInfo.revert?.messageID
        expect(revertMessageID).toBeDefined()

        // Messages should still be in the list (not removed yet, just marked for revert)
        messages = await Session.messages({ sessionID })
        expect(messages.length).toBe(4)

        // Now clean up the revert state (this is what the compact endpoint should do)
        await SessionRevert.cleanup(sessionInfo)

        // After cleanup, the reverted messages (those after the revert point) should be removed
        messages = await Session.messages({ sessionID })
        const remainingIds = messages.map((m) => m.info.id)
        // The revert point is somewhere in the message chain, so we should have fewer messages
        expect(messages.length).toBeLessThan(4)
        // userMsg2 and assistantMsg2 should be removed (they come after the revert point)
        expect(remainingIds).not.toContain(userMsg2.id)
        expect(remainingIds).not.toContain(assistantMsg2.id)

        // Revert state should be cleared
        sessionInfo = await Session.get(sessionID)
        expect(sessionInfo.revert).toBeUndefined()

        // Clean up
        await Session.remove(sessionID)
      },
    })
  })

  test("should properly clean up revert state before creating compaction message", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Create a session
        const session = await Session.create({})
        const sessionID = session.id

        // Create initial messages
        const userMsg = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID,
          agent: "default",
          model: {
            providerID: "openai",
            modelID: "gpt-4",
          },
          time: {
            created: Date.now(),
          },
        })

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMsg.id,
          sessionID,
          type: "text",
          text: "Hello",
        })

        const assistantMsg: MessageV2.Assistant = {
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID,
          mode: "default",
          agent: "default",
          path: {
            cwd: tmp.path,
            root: tmp.path,
          },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: "gpt-4",
          providerID: "openai",
          parentID: userMsg.id,
          time: {
            created: Date.now(),
          },
          finish: "end_turn",
        }
        await Session.updateMessage(assistantMsg)

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMsg.id,
          sessionID,
          type: "text",
          text: "Hi there!",
        })

        // Revert the user message
        await SessionRevert.revert({
          sessionID,
          messageID: userMsg.id,
        })

        // Check that revert state is set
        let sessionInfo = await Session.get(sessionID)
        expect(sessionInfo.revert).toBeDefined()

        // Simulate what the compact endpoint does: cleanup revert before creating compaction
        await SessionRevert.cleanup(sessionInfo)

        // Verify revert state is cleared
        sessionInfo = await Session.get(sessionID)
        expect(sessionInfo.revert).toBeUndefined()

        // Verify messages are properly cleaned up
        const messages = await Session.messages({ sessionID })
        expect(messages.length).toBe(0) // All messages should be reverted

        // Clean up
        await Session.remove(sessionID)
      },
    })
  })

  test("should keep files and emit session.error when snapshot was pruned before revert", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const errors: string[] = []
        const unsub = Bus.subscribe(Session.Event.Error, (event) => {
          const err = event.properties.error
          if (err?.name === "UnknownError") errors.push(err.data.message)
        })

        const notes = path.join(tmp.path, "notes.txt")
        await Bun.write(notes, "original")

        const session = await Session.create({})
        const id = session.id

        const user = await Session.updateMessage({
          id: Identifier.ascending("message"),
          role: "user",
          sessionID: id,
          agent: "default",
          model: {
            providerID: "openai",
            modelID: "gpt-4",
          },
          time: {
            created: Date.now(),
          },
        })

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: user.id,
          sessionID: id,
          type: "text",
          text: "Edit notes.txt",
        })

        const before = await Snapshot.track()
        expect(before).toBeTruthy()
        await Bun.write(notes, "agent edit")
        const patch = await Snapshot.patch(before!)

        const assistant: MessageV2.Assistant = {
          id: Identifier.ascending("message"),
          role: "assistant",
          sessionID: id,
          mode: "default",
          agent: "default",
          path: {
            cwd: tmp.path,
            root: tmp.path,
          },
          cost: 0,
          tokens: {
            output: 0,
            input: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: "gpt-4",
          providerID: "openai",
          parentID: user.id,
          time: {
            created: Date.now(),
          },
          finish: "end_turn",
        }
        await Session.updateMessage(assistant)

        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistant.id,
          sessionID: id,
          type: "patch",
          hash: patch.hash,
          files: patch.files,
        })

        // Advance snapshot index and prune unreferenced trees like `Snapshot.cleanup()`
        await Snapshot.track()
        const git = path.join(Global.Path.data, "snapshot", Instance.project.id)
        await $`git --git-dir ${git} reflog expire --expire=now --all`.quiet().nothrow()
        await $`git --git-dir ${git} gc --quiet --prune=now`.quiet()

        // Confirm snapshot tree was genuinely pruned (ls-tree exits non-zero, which previously triggered deletion)
        const tree = await $`git --git-dir ${git} --work-tree ${tmp.path} ls-tree ${before!} -- notes.txt`
          .quiet()
          .nothrow()
        expect(tree.exitCode).not.toBe(0)

        // User edits notes.txt manually after agent turn
        await Bun.write(notes, "manual edit")

        // Exercise the full HTTP POST /session/:sessionID/revert endpoint
        const res = await Server.App().request(`/session/${id}/revert?directory=${encodeURIComponent(tmp.path)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageID: user.id }),
        })
        expect(res.status).toBe(200)

        unsub()

        expect(await Bun.file(notes).exists()).toBe(true)
        expect(await Bun.file(notes).text()).toBe("manual edit")
        expect((await Session.get(id)).revert?.messageID).toBe(user.id)
        expect(errors).toEqual([
          "Revert kept 1 file as is because the snapshot store no longer has the earlier version: notes.txt",
        ])

        await Session.remove(id)
      },
    })
  })
})
