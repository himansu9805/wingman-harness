// Node's TS loader does not run Vite plugins. Compile the same StyleX macros
// for component tests, after tsx has handled TypeScript and JSX.
import { registerHooks } from 'node:module';
import { transformSync } from '@babel/core';
import stylex from '@stylexjs/babel-plugin';

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.includes('/apps/web/src/') || !url.endsWith('.tsx') || result.source == null) return result;
    const source = result.source.toString();
    if (!source.includes('stylex.create')) return result;
    const transformed = transformSync(source, {
      filename: new URL(url).pathname,
      babelrc: false,
      configFile: false,
      plugins: [[stylex, { runtimeInjection: false }]],
    });
    return { ...result, source: transformed.code };
  },
});
