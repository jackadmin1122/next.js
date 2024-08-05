const fs = require('node:fs/promises')
const path = require('node:path')
const glob = require('glob')

const nextjsExportsBase = {
  '.': {
    types: './index.d.ts',
    default: './dist/server/next.js',
  },
  // entrypoints that used to be automatically resolved to their corresponding index.js or json file extension
  // TODO: remove these entrypoints and write a codemod
  './dist/trace': './dist/trace/index.js',
  './dist/build/swc': './dist/build/swc/index.js',
  './dist/compiled/scheduler': './dist/compiled/scheduler/index.js',
  './dist/compiled/@next/font/google':
    './dist/compiled/@next/font/google/index.js',
  './dist/compiled/@next/font/local':
    './dist/compiled/@next/font/local/index.js',
  './dist/compiled/scheduler-experimental':
    './dist/compiled/scheduler-experimental/index.js',
  './dist/build/babel/loader': './dist/build/babel/loader/index.js',
  './dist/esm/server/lib/incremental-cache':
    './dist/esm/server/lib/incremental-cache/index.js',
  './dist/esm/server/api-utils': './dist/esm/server/api-utils/index.js',
  './font': { types: './font/index.d.ts' },
  './font/google': './font/google/index.js',
  './font/local': './font/local/index.js',
  './package': './package.json',
  // partial @mswjs/interceptors package
  './dist/compiled/@mswjs/interceptors/ClientRequest':
    './dist/compiled/@mswjs/interceptors/ClientRequest/index.js',
  // Babel packages
  // TODO: Unclear how these are even generated e.g. couldn't find mention of plugin-syntax-jsx in taskr taskfile
  './dist/compiled/babel/*': './dist/compiled/babel/*.js',
  // next/font support
  // TODO: Ask sokra if we can somewhow make generic resource queries work while also having `'./*': './*.js',` in our exports which resolves every request with resource query to .js
  './font/google/target.css?*': './next/font/google/target.css?*',
  './font/local/target.css?*': './next/font/local/target.css?*',
  // misc assets
  './*.css': './*.css',
  // e.g. for package.json
  './*.json': './*.json',
  // Support existing imports of .js files
  // TODO: arguably codemoddable so maybe good to drop. Also need to adjust our imports (e.g. in resolver aliases)
  './*.js': './*.js',
  // Support existing imports that rely on legacy behavior where modules without extension were automatically resolved to .js modules if they existed.
  './*': './*.js',
}

function rewritePackageExportsResolvePaths(entry, rootPath) {
  if (typeof entry === 'string') {
    return `./${path.join(rootPath, entry)}`
  }
  // TODO: Used by `@babel/runtime` but I don't know if that is even supported syntax
  if (Array.isArray(entry)) {
    return entry.map((nestedEntry) =>
      rewritePackageExportsResolvePaths(nestedEntry, rootPath)
    )
  }

  const resolvedExports = {}
  for (const [condition, nestedEntry] of Object.entries(entry)) {
    resolvedExports[condition] = rewritePackageExportsResolvePaths(
      nestedEntry,
      rootPath
    )
  }
  return resolvedExports
}

async function hoistNestedPackageManifests(packagePath) {
  const packageJsonPath = path.resolve(packagePath, 'package.json')

  const nextjsVendoredExports = {}
  // TODO: Consider iterating over each package instead to assert each has a package.json
  // Currently vendored packages without a package.json will be ignored leading to build errors later if they're referenced with the assumption next/dist/compiled/foo will resolve to foo/index.js
  const nestedPackageJsonPaths = glob.sync(
    path.resolve(packagePath, 'src/compiled/{*,@*/*}/package.json')
  )
  for (const nestedPackageJsonPath of nestedPackageJsonPaths) {
    const nestedPackageJson = await fs.readFile(nestedPackageJsonPath, 'utf8')
    const nestedPackageManifest = JSON.parse(nestedPackageJson)

    const nestedPackageDistPath = path
      .relative(packagePath, path.dirname(nestedPackageJsonPath))
      .replace(/^src\//, 'dist/')

    if (nestedPackageManifest.exports) {
      // hoist the `exports` of the nested package by
      // 1. prepending the entrypoints with the nested paths e.g. the `'.'` entrypoint in `dist/compiled/react/package.json` becomes `'./dist/compiled/react'`
      // 2. prepending the resolved paths with the nested paths e.g. the `./index.js` in `dist/compiled/react/package.json` becomes `'./dist/compiled/react/index.js`
      // Example: react/package.json
      // {
      //   './': {
      //     'react-server': './react.react-server.js',
      //     'default': './react.js'
      //   },
      //   './jsx': './jsx.s'
      // }
      // becomes
      // {
      //   './dist/compiled/react': {
      //     'react-server': './dist/compiled/react/react.react-server.js',
      //     'default': './dist/compiled/react/react.js'
      //   },
      //   './dist/compiled/react/jsx': './dist/compiled/react/jsx.s'
      // }
      // Note that conditions can be nested so we handle those scenarios as well
      for (const [entrypoint, resolved] of Object.entries(
        nestedPackageManifest.exports
      )) {
        const vendoredEntrypoint = `./${path.join(nestedPackageDistPath, entrypoint)}`
        nextjsVendoredExports[vendoredEntrypoint] =
          rewritePackageExportsResolvePaths(resolved, nestedPackageDistPath)
      }
    } else {
      let nestedPackageExports = {}
      if (nestedPackageManifest.types) {
        nestedPackageExports.types = `./${path.join(nestedPackageDistPath, nestedPackageManifest.types)}`
      }
      if (nestedPackageManifest.module) {
        nestedPackageExports.module = `./${path.join(nestedPackageDistPath, nestedPackageManifest.module)}`
      }
      if (nestedPackageManifest.main) {
        const mainEntryResolve = `./${path.join(nestedPackageDistPath, nestedPackageManifest.main)}`
        if (Object.keys(nestedPackageExports).length === 0) {
          // If we only have a main entry, we can save some bytes here by collapsing `{ default: ... }` to `...`
          nestedPackageExports = mainEntryResolve
        } else {
          nestedPackageExports.default = mainEntryResolve
        }
      }

      if (
        typeof nestedPackageExports === 'string' ||
        Object.keys(nestedPackageExports).length > 0
      ) {
        nextjsVendoredExports[`./${nestedPackageDistPath}`] =
          nestedPackageExports
      }
    }
  }

  // Guardrail to avoid having unused (i.e. overwritten) entrypoints in `nextjsExportsBase`
  // e.g. `scheduler` has no package.json entries and relies on old Node.js resolution behavior.
  for (const baseEntrypoint in nextjsExportsBase) {
    if (
      baseEntrypoint in nextjsVendoredExports &&
      nextjsExportsBase[baseEntrypoint] !==
        nextjsVendoredExports[baseEntrypoint]
    ) {
      throw new Error(
        `The base entrypoint ${baseEntrypoint} is already hoisted. Remove the entrypoint from the base ones in favor of the autogenerated '${baseEntrypoint}'.`
      )
    }
  }

  const nextjsExports = {
    // Prioritize the entrypoints of the vendored packages
    ...nextjsVendoredExports,
    ...nextjsExportsBase,
  }

  const nextjsPackageJson = await fs.readFile(packageJsonPath, 'utf8')
  const nextjsPackageManifest = JSON.parse(nextjsPackageJson)

  nextjsPackageManifest.exports = nextjsExports

  await fs.writeFile(
    packageJsonPath,
    JSON.stringify(nextjsPackageManifest, null, 2) +
      // Prettier would add a trailing newline as well.
      '\n'
  )
}

async function main() {
  const [unresolvePackagePath] = process.argv.slice(2)
  const packagePath = path.resolve(unresolvePackagePath)

  await hoistNestedPackageManifests(packagePath)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
