import { randomUUID } from "node:crypto";
import { expect, it, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as runs from "../agents/embedded-agent-runner/runs.js";
import type { runEmbeddedAgent as executeEmbeddedAgent } from "../agents/embedded-agent.js";
import * as goals from "../config/sessions/goals-operations.js";
import { loadSessionEntry, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../sessions/session-controller.lifecycle.js";
import { ABORTED_PARTIAL_PERSISTENCE_WARNING } from "./server-methods/chat-aborted-partial.js";
import * as chatHandler from "./server-methods/chat-send-handler.js";
import * as partials from "./server-methods/chat-transcript-persistence.js";
import type { RespondFn, GatewayRequestContext } from "./server-methods/types.js";

export function registerGoalReplacementCases(
  scope: () => { agentId: string; sessionKey: string; sessionId: string; storePath: string },
  runEmbeddedAgent: MockInstance<typeof executeEmbeddedAgent>,
  rpc: (
    method: "chat.send" | "sessions.goal.update",
    params: Record<string, unknown>,
  ) => Promise<MockInstance<RespondFn>>,
  goalStart: (message: string) => Record<string, unknown>,
  getContext: () => GatewayRequestContext,
) {
  it.each([
    "success",
    "pause-retry",
    "edit-retry",
    "resume-retry",
    "concurrent-edit",
    "abort-warning",
  ] as const)(
    "settles the exact executing turn before pause/edit/resume (%s)",
    async (mode) => {
      const started = createDeferred();
      const interrupted = createDeferred();
      const physicalRelease = createDeferred();
      const resumed = createDeferred();
      const resumedRelease = createDeferred();
      const order: string[] = [];
      let originalRun = "";
      let oldSettled = false;
      const mutate = goals.mutateSessionGoal;
      const persistence =
        mode === "abort-warning"
          ? vi
              .spyOn(partials, "persistAbortedPartials")
              .mockResolvedValue(ABORTED_PARTIAL_PERSISTENCE_WARNING)
          : undefined;
      let failStage = mode === "edit-retry" ? "edit" : mode === "pause-retry" ? "pause" : undefined;
      const resume = chatHandler.handleSessionGoalResumeChat;
      const resumeSpy = vi.spyOn(chatHandler, "handleSessionGoalResumeChat");
      if (mode === "resume-retry" || mode === "concurrent-edit") {
        resumeSpy.mockImplementationOnce(async (options, operation) => {
          if (mode === "resume-retry") {
            options.respond(false, undefined, {
              code: "UNAVAILABLE",
              message: "Admission unavailable",
            });
            return;
          }
          await patchSessionEntryCore(scope(), (entry) => ({
            goal: entry.goal && {
              ...entry.goal,
              objective: "A newer operator decision",
              updatedAt: Date.now() + 1,
            },
          }));
          await resume(options, operation);
        });
      }
      runEmbeddedAgent.mockImplementation(async (params) => {
        const first = runEmbeddedAgent.mock.calls.length === 1;
        if (first) {
          originalRun = params.runId!;
          const abort = new AbortController();
          const cancel = () => {
            order.push("interrupt");
            abort.abort();
            interrupted.resolve();
          };
          const backend = {
            kind: "embedded" as const,
            runId: params.runId,
            cancel,
            abort: cancel,
            isStreaming: () => !abort.signal.aborted,
            isAborted: () => abort.signal.aborted,
            isCompacting: () => false,
            queueMessage: async () => {},
          };
          params.replyOperation?.attachBackend(backend);
          runs.attachActiveEmbeddedRun(
            params.sessionId,
            backend,
            scope().sessionKey,
            params.sessionFile,
            "main",
            params.replyOperation,
          );
          started.resolve();
          try {
            await physicalRelease.promise;
          } finally {
            runs.detachActiveEmbeddedRun(
              params.sessionId,
              backend,
              scope().sessionKey,
              params.sessionFile,
            );
            params.replyOperation?.detachBackend(backend);
          }
          oldSettled = true;
          order.push("settled");
          await patchSessionEntryCore(scope(), () => ({
            lifecycleRunId: undefined,
            lastRunId: originalRun,
            abortedLastRun: true,
          }));
          return {
            payloads: [],
            meta: {
              durationMs: 0,
              aborted: true,
              stopReason: "aborted",
              agentMeta: {
                sessionId: params.sessionId,
                provider: "test",
                model: "test",
                usage: { input: 1, output: 1 },
              },
            },
          };
        }
        order.push("resumed");
        expect(oldSettled).toBe(true);
        resumed.resolve();
        await resumedRelease.promise;
        await patchSessionEntryCore(scope(), (entry) => ({
          goal: entry.goal && { ...entry.goal, status: "complete" },
        }));
        return {
          payloads: [{ text: "The updated checklist is complete." }],
          meta: {
            durationMs: 0,
            agentMeta: {
              sessionId: params.sessionId,
              provider: "test",
              model: "test",
              usage: { input: 1, output: 1 },
            },
          },
        };
      });
      let replace: Promise<MockInstance<RespondFn>> | undefined;
      try {
        await patchSessionEntryCore(scope(), () => ({ totalTokens: 100, totalTokensFresh: true }));
        expect(
          (await rpc("chat.send", goalStart("Finish the original checklist"))).mock.calls[0]?.[0],
        ).toBe(true);
        await started.promise;
        vi.spyOn(goals, "mutateSessionGoal").mockImplementation(async (options) => {
          order.push(options.operation.action);
          expect(oldSettled, options.operation.action).toBe(true);
          if (options.operation.action === failStage) {
            failStage = undefined;
            throw new Error("Stage unavailable");
          }
          return await mutate(options);
        });
        const original = loadSessionEntry(scope())!.goal!;
        if (mode === "abort-warning") {
          getContext().chatRunState.getOrCreate(originalRun).buffer =
            "Checking the deployment checklist.";
        }
        const request = {
          sessionKey: scope().sessionKey,
          agentId: "main",
          sessionId: scope().sessionId,
          action: "replace",
          operationId: randomUUID(),
          issuedAtMs: Date.now(),
          goalId: original.id,
          expectedGoalUpdatedAt: original.updatedAt,
          expectedRunId: originalRun,
          objective: "Finish the replacement checklist",
        };
        if (mode === "success") {
          const target = captureSessionTarget({
            storeScope: scope().storePath,
            sessionKey: scope().sessionKey,
            incarnation: scope().sessionId,
          });
          const owner = Symbol("unrelated-admission");
          const first = await beginSessionEffect({ target, owner, serializeOwner: true });
          const unrelatedInterrupted = vi.fn();
          const pending = beginSessionEffect({
            target,
            owner,
            serializeOwner: true,
            onInterrupt: unrelatedInterrupted,
          });
          const owned = Promise.allSettled([pending]);
          try {
            for (const stale of [
              { expectedRunId: "a-newer-or-unrelated-turn" },
              { expectedGoalUpdatedAt: original.updatedAt + 1 },
            ]) {
              const rejected = await rpc("sessions.goal.update", {
                ...request,
                ...stale,
                operationId: randomUUID(),
              });
              expect(rejected.mock.calls[0]?.[0]).toBe(false);
              expect(order).toEqual([]);
              expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
              expect(unrelatedInterrupted).not.toHaveBeenCalled();
            }
          } finally {
            first.release();
            const [settled] = await owned;
            if (settled.status === "fulfilled") {
              settled.value.release();
            }
            expect(settled.status).toBe("fulfilled");
          }
        }
        replace = rpc("sessions.goal.update", request);
        await Promise.race([
          interrupted.promise,
          replace.then((response) => {
            throw new Error(JSON.stringify(response.mock.calls));
          }),
        ]);
        expect(loadSessionEntry(scope())?.goal).toMatchObject({
          id: original.id,
          status: "active",
          objective: original.objective,
        });
        expect(order).toEqual(["interrupt"]);
        physicalRelease.resolve();
        let response = await replace;
        if (mode !== "success") {
          expect(response.mock.calls[0]).toMatchObject([false, undefined, { code: "UNAVAILABLE" }]);
          expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
          expect(loadSessionEntry(scope())?.goal).toMatchObject({
            id: original.id,
            status: mode === "pause-retry" || mode === "abort-warning" ? "active" : "paused",
            objective:
              mode === "edit-retry" || mode === "pause-retry" || mode === "abort-warning"
                ? original.objective
                : mode === "concurrent-edit"
                  ? "A newer operator decision"
                  : request.objective,
          });
          if (mode === "abort-warning") {
            expect(response.mock.calls[0]?.[2]?.message).toContain("could not be saved to history");
            return;
          }
          if (mode === "concurrent-edit") {
            return;
          }
          response = await rpc("sessions.goal.update", request);
        }
        expect(
          response.mock.calls[0]?.slice(0, 2),
          JSON.stringify(response.mock.calls),
        ).toMatchObject([true, { action: "replace", status: "started", goalId: original.id }]);
        await resumed.promise;
        const updated = loadSessionEntry(scope())!.goal!;
        expect(updated).toMatchObject({
          id: original.id,
          status: "active",
          objective: request.objective,
          tokenStart: original.tokenStart,
        });
        expect(updated.tokenBudget).toBe(original.tokenBudget);
        expect(order.indexOf("settled")).toBeLessThan(order.indexOf("pause"));
        expect(order.indexOf("pause")).toBeLessThan(order.indexOf("edit"));
        expect(order.indexOf("edit")).toBeLessThan(order.indexOf("resumed"));
        const replay = await rpc("sessions.goal.update", request);
        expect(replay.mock.calls[0]?.slice(0, 2)).toMatchObject([
          true,
          { action: "replace", replayed: true },
        ]);
        expect(runEmbeddedAgent).toHaveBeenCalledTimes(2);
        expect(order.filter((stage) => stage === "interrupt")).toHaveLength(1);
      } finally {
        physicalRelease.resolve();
        resumedRelease.resolve();
        await replace;
        await patchSessionEntryCore(scope(), (entry) => ({
          goal: entry.goal && { ...entry.goal, status: "complete" },
        }));
        expect((await waitForGatewayActiveWork(30_000)).drained).toBe(true);
        vi.mocked(goals.mutateSessionGoal).mockRestore();
        resumeSpy.mockRestore();
        persistence?.mockRestore();
      }
    },
    35_000,
  );
}
