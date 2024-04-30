import "#internal/nitro/virtual/polyfill";
import type {
  Request as CFRequest,
  EventContext,
  ExecutionContext,
} from "@cloudflare/workers-types";
import { instrument } from '@microlabs/otel-cf-workers'
import type { ResolveConfigFn } from '@microlabs/otel-cf-workers'
import wsAdapter from "crossws/adapters/cloudflare";
import { runCronTasks } from "nitropack/runtime/task";
import { requestHasBody } from "nitropack/runtime/utils";
import { nitroApp } from "nitropack/runtime/app";

// TODO how do I Import this
// import { isPublicAssetURL } from "nitropack/runtime/virtual/public-assets";

/**
 * Reference: https://developers.cloudflare.com/workers/runtime-apis/fetch-event/#parameters
 */

interface CFPagesEnv {
  ASSETS: { fetch: (request: CFRequest) => Promise<Response> };
  CF_PAGES: "1";
  CF_PAGES_BRANCH: string;
  CF_PAGES_COMMIT_SHA: string;
  CF_PAGES_URL: string;
  BASELIME_API_KEY: string;
  [key: string]: any;
}

const ws = import.meta._websocket
  ? wsAdapter(nitroApp.h3App.websocket)
  : undefined;

const handler =  {
  async fetch(
    request: CFRequest,
    env: CFPagesEnv,
    context: EventContext<CFPagesEnv, string, any>
  ) {
    // Websocket upgrade
    if (
      import.meta._websocket &&
      request.headers.get("upgrade") === "websocket"
    ) {
      return ws!.handleUpgrade(request as any, env, context);
    }

    const url = new URL(request.url);
    // if (env.ASSETS /* !miniflare */ && isPublicAssetURL(url.pathname)) {
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    let body;
    if (requestHasBody(request as unknown as Request)) {
      body = Buffer.from(await request.arrayBuffer());
    }

    // Expose latest env to the global context
    (globalThis as any).__env__ = env;

    return nitroApp.localFetch(url.pathname + url.search, {
      context: {
        cf: request.cf,
        waitUntil: (promise: Promise<any>) => context.waitUntil(promise),
        cloudflare: {
          request,
          env,
          context,
        },
      },
      host: url.hostname,
      protocol: url.protocol,
      method: request.method,
      headers: request.headers as unknown as Headers,
      body,
    });
  },
  scheduled(event: any, env: CFPagesEnv, context: ExecutionContext) {
    if (import.meta._tasks) {
      (globalThis as any).__env__ = env;
      context.waitUntil(
        runCronTasks(event.cron, {
          context: {
            cloudflare: {
              env,
              context,
            },
          },
          payload: {},
        })
      );
    }
  },
};

const config: ResolveConfigFn = (env: CFPagesEnv) => {
	return {
		exporter: {
			url: 'https://otel.baselime.io/v1',
			headers: { 'x-api-key': env.BASELIME_API_KEY },
		},
		service: { name: env.SERVICE_NAME },
	}
}
// @ts-ignore
export default instrument(handler, config)
