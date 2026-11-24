import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { ManagedPolicyDocument } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

const respond204 = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })));

const analyticsLayerWith = (client: HttpClient.HttpClient, policy?: ManagedPolicyDocument) =>
  AnalyticsService.layer.pipe(
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-telemetry-privacy-" }),
    ),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          // The environment opts in on purpose: the privacy build must still send nothing.
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
        }),
      ),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcess.Platform, "win32"),
        Layer.succeed(HostProcess.Architecture, "x64"),
        Layer.succeed(HttpClient.HttpClient, client),
        ManagedPolicy.layerTest(policy),
      ),
    ),
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("AnalyticsService test", (it) => {
  // Privacy build: telemetry never sends, whatever the environment or a policy says.
  it.effect("never sends telemetry even when the environment and a policy opt in", () =>
    Effect.gen(function* () {
      let requests = 0;
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          requests += 1;
          return yield* respond204(request);
        }),
      );
      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        for (let index = 0; index < 20; index += 1) {
          yield* analytics.record("test.privacy", { index });
        }
        yield* analytics.recordOwners([{ source: "connect", ownerId: "a".repeat(64) }], "server");
        yield* analytics.flush;
        yield* TestClock.adjust("5 minutes");
      }).pipe(
        Effect.provide(
          analyticsLayerWith(client, {
            schemaVersion: 1,
            organization: "Example Corp",
            limits: { telemetry: true },
          }),
        ),
      );
      assert.equal(requests, 0);
    }),
  );

  it.effect("does not send batch requests when T3CODE_TELEMETRY_ENABLED is set", () =>
    Effect.gen(function* () {
      const capturedPaths: Array<string> = [];
      const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-telemetry-disabled-",
      });
      const layerTelemetry = AnalyticsService.layer.pipe(Layer.provideMerge(layerServerConfig));
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          T3CODE_TELEMETRY_ENABLED: true,
          T3CODE_POSTHOG_KEY: "phc_test_key",
          T3CODE_POSTHOG_HOST: "http://localhost",
        }),
      );
      const layerBatchServer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          capturedPaths.push(request.url);
          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const layerRuntime = layerTelemetry.pipe(
        Layer.provide(layerConfig),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcess.Platform, "linux"),
            Layer.succeed(HostProcess.Architecture, "arm64"),
            ManagedPolicy.layerTest(),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(layerBatchServer).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService.AnalyticsService;
        yield* analytics.record("test.disabled", { index: 1 });
        yield* analytics.flush;
      }).pipe(Effect.provide(layerRuntime));

      assert.deepEqual(capturedPaths, []);
    }),
  );

  it.effect("shutdown stops waiting for a telemetry endpoint that never answers", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        analyticsLayerWith(HttpClient.make(() => Effect.never)),
        scope,
      );
      yield* Effect.gen(function* () {
        const analytics = yield* AnalyticsService.AnalyticsService;
        for (let index = 0; index < 20; index += 1) {
          yield* analytics.record("test.retry", { index });
        }
      }).pipe(Effect.provide(context));

      const shutdown = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(shutdown);
    }),
  );
});
