import { existsSync, promises as fsp } from "node:fs";
import { resolve, join } from "pathe";
import {
  joinURL,
  withLeadingSlash,
  withTrailingSlash,
  withoutLeadingSlash,
} from "ufo";
import { parseTOML, stringifyTOML } from "confbox";
import { globby } from "globby";
import type { Nitro } from "nitropack";
import { fileURLToPath } from "node:url"


import defu from "defu";
import { isCI } from "std-env";

export interface CloudflarePagesRoutes {
    /** Defines the version of the schema. Currently there is only one version of the schema (version 1), however, we may add more in the future and aim to be backwards compatible. */
    version?: 1;
  
    /** Defines routes that will be invoked by Functions. Accepts wildcard behavior. */
    include?: string[];
  
    /** Defines routes that will not be invoked by Functions. Accepts wildcard behavior. `exclude` always take priority over `include`. */
    exclude?: string[];
  }
  
export default {
  extends: "cloudflare",
  entry: fileURLToPath(new URL("./nuxt-otel-entry.ts", import.meta.url)),
  exportConditions: ["workerd"],
  commands: {
    preview: "npx wrangler pages dev ./",
    deploy: "npx wrangler pages deploy ./",
  },
  output: {
    dir: "{{ rootDir }}/dist",
    publicDir: "{{ output.dir }}",
    serverDir: "{{ output.dir }}/_worker.js",
  },
  alias: {
    // Hotfix: Cloudflare appends /index.html if mime is not found and things like ico are not in standard lite.js!
    // https://github.com/unjs/nitro/pull/933
    _mime: "mime/index.js",
  },
  wasm: {
    lazy: false,
    esmImport: true,
  },
  rollupConfig: {
    output: {
      entryFileNames: "index.js",
      format: "esm",
      inlineDynamicImports: false,
    },
  },
  hooks: {
    async compiled(nitro: Nitro) {
      await writeCFRoutes(nitro);
      await writeCFPagesHeaders(nitro);
      await writeCFPagesRedirects(nitro);
      await writeCFWrangler(nitro);
    },
  },
};

async function writeCFRoutes(nitro: Nitro) {
  const _cfPagesConfig = nitro.options.cloudflare?.pages || {};
  const routes: CloudflarePagesRoutes = {
    version: _cfPagesConfig.routes?.version || 1,
    include: _cfPagesConfig.routes?.include || ["/*"],
    exclude: _cfPagesConfig.routes?.exclude || [],
  };

  const writeRoutes = () =>
    fsp.writeFile(
      resolve(nitro.options.output.publicDir, "_routes.json"),
      JSON.stringify(routes, undefined, 2)
    );

  if (_cfPagesConfig.defaultRoutes === false) {
    await writeRoutes();
    return;
  }

  // Exclude public assets from hitting the worker
  const explicitPublicAssets = nitro.options.publicAssets.filter(
    (dir, index, array) => {
      if (dir.fallthrough || !dir.baseURL) {
        return false;
      }

      const normalizedBase = withoutLeadingSlash(dir.baseURL);

      return !array.some(
        (otherDir, otherIndex) =>
          otherIndex !== index &&
          normalizedBase.startsWith(
            withoutLeadingSlash(withTrailingSlash(otherDir.baseURL))
          )
      );
    }
  );

  // Explicit prefixes
  routes.exclude!.push(
    ...explicitPublicAssets
      .map((dir) => joinURL(dir.baseURL!, "*"))
      .sort(comparePaths)
  );

  // Unprefixed assets
  const publicAssetFiles = await globby("**", {
    cwd: nitro.options.output.publicDir,
    absolute: false,
    dot: true,
    ignore: [
      "_worker.js",
      "_worker.js.map",
      "nitro.json",
      ...routes.exclude!.map((path) =>
        withoutLeadingSlash(path.replace(/\/\*$/, "/**"))
      ),
    ],
  });
  routes.exclude!.push(
    ...publicAssetFiles.map((i) => withLeadingSlash(i)).sort(comparePaths)
  );

  // Only allow 100 rules in total (include + exclude)
  routes.exclude!.splice(100 - routes.include!.length);

  await writeRoutes();
}

function comparePaths(a: string, b: string) {
  return a.split("/").length - b.split("/").length || a.localeCompare(b);
}

async function writeCFPagesHeaders(nitro: Nitro) {
  const headersPath = join(nitro.options.output.publicDir, "_headers");
  const contents = [];

  const rules = Object.entries(nitro.options.routeRules).sort(
    (a, b) => b[0].split(/\/(?!\*)/).length - a[0].split(/\/(?!\*)/).length
  );

  for (const [path, routeRules] of rules.filter(
    ([_, routeRules]) => routeRules.headers
  )) {
    const headers = [
      path.replace("/**", "/*"),
      ...Object.entries({ ...routeRules.headers }).map(
        ([header, value]) => `  ${header}: ${value}`
      ),
    ].join("\n");

    contents.push(headers);
  }

  if (existsSync(headersPath)) {
    const currentHeaders = await fsp.readFile(headersPath, "utf8");
    if (/^\/\* /m.test(currentHeaders)) {
      nitro.logger.info(
        "Not adding Nitro fallback to `_headers` (as an existing fallback was found)."
      );
      return;
    }
    nitro.logger.info(
      "Adding Nitro fallback to `_headers` to handle all unmatched routes."
    );
    contents.unshift(currentHeaders);
  }

  await fsp.writeFile(headersPath, contents.join("\n"));
}

async function writeCFPagesRedirects(nitro: Nitro) {
  const redirectsPath = join(nitro.options.output.publicDir, "_redirects");
  const staticFallback = existsSync(
    join(nitro.options.output.publicDir, "404.html")
  )
    ? "/* /404.html 404"
    : "";
  const contents = [staticFallback];
  const rules = Object.entries(nitro.options.routeRules).sort(
    (a, b) => a[0].split(/\/(?!\*)/).length - b[0].split(/\/(?!\*)/).length
  );

  for (const [key, routeRules] of rules.filter(
    ([_, routeRules]) => routeRules.redirect
  )) {
    const code = routeRules.redirect!.statusCode;
    contents.unshift(
      `${key.replace("/**", "/*")}\t${routeRules.redirect!.to}\t${code}`
    );
  }

  if (existsSync(redirectsPath)) {
    const currentRedirects = await fsp.readFile(redirectsPath, "utf8");
    if (/^\/\* /m.test(currentRedirects)) {
      nitro.logger.info(
        "Not adding Nitro fallback to `_redirects` (as an existing fallback was found)."
      );
      return;
    }
    nitro.logger.info(
      "Adding Nitro fallback to `_redirects` to handle all unmatched routes."
    );
    contents.unshift(currentRedirects);
  }

  await fsp.writeFile(redirectsPath, contents.join("\n"));
}

async function writeCFWrangler(nitro: Nitro) {
  type WranglerConfig = typeof nitro.options.cloudflare.wrangler;

  const inlineConfig: WranglerConfig =
    nitro.options.cloudflare?.wrangler || ({} as WranglerConfig);

  // Write wrangler.toml only if config is not empty
  if (!inlineConfig || Object.keys(inlineConfig).length === 0) {
    return;
  }

  let configFromFile: WranglerConfig = {} as WranglerConfig;
  const configPath = resolve(
    nitro.options.rootDir,
    inlineConfig.configPath || "wrangler.toml"
  );
  if (existsSync(configPath)) {
    configFromFile = parseTOML<WranglerConfig>(
      await fsp.readFile(configPath, "utf8")
    );
  }

  const wranglerConfig: WranglerConfig = defu(configFromFile, inlineConfig);

  const wranglerPath = join(
    isCI ? nitro.options.rootDir : nitro.options.buildDir,
    "wrangler.toml"
  );

  await fsp.writeFile(wranglerPath, stringifyTOML(wranglerConfig));
}
